import { App } from 'aws-cdk-lib';
import { SiteStack } from '../lib/site-stack.ts';

const app = new App();

new SiteStack(app, 'BlogSiteStack', {
  description: 'shutx-net blog: private S3 + CloudFront (OAC) static site delivery',
});
