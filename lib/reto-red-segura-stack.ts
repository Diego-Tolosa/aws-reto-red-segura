import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as s3 from 'aws-cdk-lib/aws-s3';

export class RetoRedSeguraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // ---------------------------------------------------------------------
    // VPC
    // ---------------------------------------------------------------------
    // Red aislada con CIDR /16.
    // 2 subnets publicas + 2 subnets privadas, una por AZ.
    // Las publicas tienen salida directa por IGW.
    // Las privadas salen a internet via NAT Gateway (egress-only).
    const vpc = new ec2.Vpc(this, 'SecureVpc', {
      ipAddresses: ec2.IpAddresses.cidr('10.0.0.0/16'),
      maxAzs: 2,
      natGateways: 2,
      subnetConfiguration: [
        {
          name: 'Public',
          subnetType: ec2.SubnetType.PUBLIC,
          cidrMask: 24,
        },
        {
          name: 'Private',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
          cidrMask: 24,
        },
      ],
    });

    // ---------------------------------------------------------------------
    // Bucket S3 para VPC Flow Logs
    // ---------------------------------------------------------------------
    // Almacena los registros de tráfico de la VPC para auditoria.
    // Se elige S3 en lugar de CloudWatch Logs por costo.
    // removalPolicy DESTROY + autoDeleteObjects para que cdk destroy lo
    // elimine sin dejar residuos, pero solo para este laboratorio.
    const flowLogsBucket = new s3.Bucket(this, 'FlowLogsBucket', {
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      encryption: s3.BucketEncryption.S3_MANAGED,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(7),
          id: 'Expirar logs a los 7 dias',
        },
      ],
    });

     // ---------------------------------------------------------------------
    // Bucket Policy para permitir a VPC Flow Logs escribir en el bucket
    // ---------------------------------------------------------------------
    // Sin esta policy, el Flow Log se crea pero nunca escribe nada
    // (falla silenciosamente). Es un requisito no obvio de AWS.
    flowLogsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
        actions: ['s3:PutObject'],
        resources: [`${flowLogsBucket.bucketArn}/*`],
        conditions: {
          StringEquals: {
            's3:x-amz-acl': 'bucket-owner-full-control',
          },
        },
      }),
    );

    flowLogsBucket.addToResourcePolicy(
      new iam.PolicyStatement({
        effect: iam.Effect.ALLOW,
        principals: [new iam.ServicePrincipal('delivery.logs.amazonaws.com')],
        actions: ['s3:GetBucketAcl'],
        resources: [flowLogsBucket.bucketArn],
      }),
    );

    // ---------------------------------------------------------------------
    // VPC Flow Log — auditoria de trafico
    // ---------------------------------------------------------------------
    // Registra ACEPTADOS y RECHAZADOS a nivel de VPC.
    // Todo el trafico va al bucket S3 de arriba.
    // Filtro ALL para auditar tanto conexiones permitidas como bloqueadas.
    new ec2.FlowLog(this, 'VpcFlowLog', {
      resourceType: ec2.FlowLogResourceType.fromVpc(vpc),
      destination: ec2.FlowLogDestination.toS3(flowLogsBucket),
      trafficType: ec2.FlowLogTrafficType.ALL,
    });

    // ---------------------------------------------------------------------
    // Security Group de la capa web (publica)
    // ---------------------------------------------------------------------
    // Recibe HTTP/HTTPS desde cualquier origen en internet.
    // Es el unico SG con acceso directo desde 0.0.0.0/0.
    const webSg = new ec2.SecurityGroup(this, 'WebSg', {
      vpc,
      description: 'Capa web: HTTP/HTTPS desde internet',
      allowAllOutbound: true,
    });

    webSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(80),
      'HTTP desde internet',
    );

    webSg.addIngressRule(
      ec2.Peer.anyIpv4(),
      ec2.Port.tcp(443),
      'HTTPS desde internet',
    );

    // ---------------------------------------------------------------------
    // Security Group de la capa de base de datos (privada)
    // ---------------------------------------------------------------------
    // NO tiene ninguna regla con origen 0.0.0.0/0.
    // Solo acepta trafico proveniente del SG de la capa web.
    const dbSg = new ec2.SecurityGroup(this, 'DbSg', {
      vpc,
      description: 'Capa DB: solo trafico desde la capa web',
      allowAllOutbound: true,
    });

    dbSg.addIngressRule(
      webSg,
      ec2.Port.tcp(3306),
      'MySQL solo desde la capa web',
    );

    // ---------------------------------------------------------------------
    // IAM Role para las instancias de prueba
    // ---------------------------------------------------------------------
    // Ambas instancias usan Session Manager (SSM) para pruebas sin abrir
    // puerto 22. Nada mas.
    const instanceRole = new iam.Role(this, 'InstanceRole', {
      assumedBy: new iam.ServicePrincipal('ec2.amazonaws.com'),
      description: 'Rol de instancias de prueba con acceso SSM',
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('AmazonSSMManagedInstanceCore'),
      ],
    });

    // ---------------------------------------------------------------------
    // Instancia web (subnet publica)
    // ---------------------------------------------------------------------
    // Simula la capa web. Usa el SG web-sg.
    const webInstance = new ec2.Instance(this, 'WebInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PUBLIC },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: webSg,
      role: instanceRole,
    });

    // ---------------------------------------------------------------------
    // Instancia db (subnet privada)
    // ---------------------------------------------------------------------
    // Simula la capa de base de datos.
    // No tiene IP publica y usa el SG db-sg.
    // Debe poder salir a internet via NAT, pero no recibir trafico entrante.
    const dbInstance = new ec2.Instance(this, 'DbInstance', {
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
      machineImage: ec2.MachineImage.latestAmazonLinux2023(),
      securityGroup: dbSg,
      role: instanceRole,
    });

    // ---------------------------------------------------------------------
    // Outputs
    // ---------------------------------------------------------------------
    new cdk.CfnOutput(this, 'WebInstanceId', {
      value: webInstance.instanceId,
      description: 'Instance ID de la capa web (publica)',
    });

    new cdk.CfnOutput(this, 'DbInstanceId', {
      value: dbInstance.instanceId,
      description: 'Instance ID de la capa db (privada)',
    });

  }
}
