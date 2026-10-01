#!/usr/bin/env node
import * as cdk from 'aws-cdk-lib/core';
import { RetoRedSeguraStack } from '../lib/reto-red-segura-stack';

const app = new cdk.App();
  new RetoRedSeguraStack(app, 'RetoRedSeguraStack', {
  env: {
    account: '299014720567',
    region: 'us-east-1',
  },
});
