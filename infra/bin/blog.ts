import { App } from 'aws-cdk-lib';
import { CicdStack } from '../lib/cicd-stack.ts';
import { SiteStack } from '../lib/site-stack.ts';

const app = new App();

const site = new SiteStack(app, 'BlogSiteStack', {
  description: 'shutx-net blog: private S3 + CloudFront (OAC) static site delivery',
});

// 参照は CicdStack -> SiteStack の一方向だけ。逆向きの参照を足すと
// クロススタック参照が循環して synth が落ちる（README を参照）。
new CicdStack(app, 'BlogCicdStack', {
  description: 'shutx-net blog: GitHub Actions OIDC deploy role (least privilege)',
  siteBucket: site.siteBucket,
  distribution: site.distribution,
});
