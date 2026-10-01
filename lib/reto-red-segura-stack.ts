import * as cdk from 'aws-cdk-lib/core';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';

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

  }
}
