# Reto AWS — Diseño de una Red Segura

VPC con separación entre capa pública (web) y capa privada (base de datos), definida completamente con AWS CDK.

## Arquitectura

```
                            Internet
                                |
                                v
                        +---------------+
                        |      IGW      |
                        +-------+-------+
                                |
                +---------------+---------------+
                |                               |
                v                               v
        +---------------+               +---------------+
        | PublicSubnet1 |               | PublicSubnet2 |
        |   10.0.0.0/24 |               |   10.0.1.0/24 |
        |  + NAT GW 1   |               |  + NAT GW 2   |
        |  + WebInstance|               |               |
        +-------+-------+               +-------+-------+
                |                               |
                v                               v
        +---------------+               +---------------+
        | PrivateSubnet1|               | PrivateSubnet2|
        |   10.0.2.0/24 |               |   10.0.3.0/24 |
        |               |               | + DbInstance  |
        +---------------+               +---------------+

        Zona de disponibilidad: us-east-1a (izq) / us-east-1b (der)
```

## Servicios AWS

| Servicio | Rol en el reto |
|---|---|
| VPC | Red virtual aislada con CIDR /16 |
| Subnets | 2 públicas + 2 privadas, una por AZ |
| Route Tables | Pública → IGW, Privada → NAT GW |
| IGW | Puerta de entrada/salida a internet |
| NAT Gateway | Salida a internet para subnets privadas |
| Security Groups | Firewall a nivel de instancia |
| VPC Flow Logs | Auditoría del tráfico de red |
| SSM Session Manager | Acceso a instancias sin abrir SSH |

## Topología

- **VPC:** `10.0.0.0/16`
- **Subnets públicas:** `10.0.0.0/24`, `10.0.1.0/24`
- **Subnets privadas:** `10.0.2.0/24`, `10.0.3.0/24`
- **2 AZs:** `us-east-1a`, `us-east-1b`
- **2 NAT Gateways:** uno por AZ (para resiliencia)

## Estructura del proyecto

```
reto-red-segura/
├── bin/
│   └── reto-red-segura.ts        # Punto de entrada del CDK App
├── lib/
│   └── reto-red-segura-stack.ts  # Definición del stack
├── test/
├── cdk.json
├── cdk.context.json
├── package.json
└── tsconfig.json
```

## Requisitos previos

- Node.js 18+
- AWS CLI con un perfil que pueda asumir los roles de bootstrap
- Cuenta AWS bootstrappeada (`cdk bootstrap`)

En este proyecto:
- Cuenta: `299014720567`
- Región: `us-east-1`
- Perfil CLI: `cdk-developer`

## Comandos

```bash
npm install

npx tsc

AWS_PROFILE=cdk-developer cdk synth
AWS_PROFILE=cdk-developer cdk diff
AWS_PROFILE=cdk-developer cdk deploy
AWS_PROFILE=cdk-developer cdk destroy
```

## Detalles de implementación

### VPC

```ts
const vpc = new ec2.Vpc(this, 'SecureVpc', {
  ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
  maxAzs: 2,
  natGateways: 2,
  subnetConfiguration: [
    { name: 'Public',  subnetType: ec2.SubnetType.PUBLIC,              cidrMask: 24 },
    { name: 'Private', subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS, cidrMask: 24 },
  ],
});
```

`PRIVATE_WITH_EGRESS` hace que CDK cree automáticamente el NAT Gateway y las rutas correspondientes.

### Route Tables

**Subnets públicas:**
```
0.0.0.0/0  →  Internet Gateway
```

**Subnets privadas:**
```
0.0.0.0/0  →  NAT Gateway de su AZ
```

### Security Groups

**web-sg:**
- Ingress TCP 80 desde `0.0.0.0/0`
- Ingress TCP 443 desde `0.0.0.0/0`
- Egress: todo

**db-sg:**
- Ingress TCP 3306 **solo desde `web-sg`**
- **Sin ninguna regla con `0.0.0.0/0`**
- Egress: todo

### Instancias de prueba

- `WebInstance`: en `PrivateSubnet`... no, en `PublicSubnet`. Con SSM habilitado.
- `DbInstance`: en `PrivateSubnet`. Sin IP pública. Con SSM habilitado.

Ambas usan el managed policy `AmazonSSMManagedInstanceCore` para poder administrarlas vía Session Manager sin abrir el puerto 22.

### VPC Flow Logs

- Captura tráfico `ALL` (aceptado y rechazado).
- Destino: bucket S3 con lifecycle de 7 días.
- Bucket con `removalPolicy: DESTROY` + `autoDeleteObjects: true` para que `cdk destroy` no deje residuos.

**Nota importante:** el bucket necesita una Bucket Policy explícita que permita a `delivery.logs.amazonaws.com` escribir. CDK no la agrega automáticamente, y sin ella el Flow Log falla silenciosamente.

## Pruebas realizadas

### Salida a internet desde la instancia privada

Desde SSM en la instancia db (privada):

```bash
curl -s -o /dev/null -w "%{http_code}\n" https://aws.amazon.com
# -> 200
```

Confirma que la privada **sí puede salir** a internet vía NAT Gateway.

### Instancia privada sin IP pública

En EC2 → Instances → DbInstance: **Public IPv4 address = vacío**. No es enrutable desde internet.

### Sin ruta al IGW desde la privada

Desde SSM en la instancia db:

```bash
ip route
# default via 10.0.2.1 dev ens5
```

La ruta por defecto apunta al router de la VPC, que envía al NAT Gateway. No hay ninguna ruta directa al IGW.

### Security Group web → db

Desde SSM en la instancia web:

```bash
timeout 10 bash -c "</dev/tcp/10.0.2.219/3306" && echo "CONECTO" || echo "FALLO"
# -> bash: connect: Connection refused
```

`Connection refused` significa que el paquete **llegó** a la db y fue rechazado por el kernel (no hay MySQL corriendo). Es decir, el `db-sg` **sí permitió** el tráfico desde `web-sg`. Eso es exactamente lo que debe pasar.

### Verificación en cdk synth

Se verificó con `grep` sobre el template sintetizado que:

- El recurso `AWS::EC2::SecurityGroup` del `DbSg` **no tiene** ningún `SecurityGroupIngress` inline con `0.0.0.0/0`.
- El único ingress del `DbSg` es `AWS::EC2::SecurityGroupIngress` con origen `${WebSg.GroupId}`.

## Cleanup

```bash
AWS_PROFILE=cdk-developer cdk destroy
```

Verificar que no quedaron recursos huérfanos:

- **EC2 → Volumes:** sin volúmenes disponibles.
- **EC2 → NAT Gateways:** sin NATs activos.
- **VPC:** la VPC del stack eliminada.
- **S3:** el bucket de Flow Logs eliminado (gracias a `autoDeleteObjects: true`).

## Notas

- La VPC creada por CDK agrega un Lambda custom resource (`VpcRestrictDefaultSG`) que elimina las reglas del Security Group default. Es comportamiento por defecto de CDK y buena práctica de seguridad.
- El perfil `cdk-developer` reutiliza el bootstrap `CDKToolkit` ya existente en la cuenta.
- Este proyecto usa 2 NAT Gateways (uno por AZ) para tolerar la caída de una AZ. Si se prioriza el costo, puede usarse `natGateways: 1` — la contrapartida es que las privadas de la otra AZ pierden salida si cae esa AZ.
