import * as cdk from 'aws-cdk-lib';
import { SecretValue } from 'aws-cdk-lib';
import { BuildSpec, Project, Source } from 'aws-cdk-lib/aws-codebuild';
import { EcsDeploymentGroup } from 'aws-cdk-lib/aws-codedeploy';
import { Artifact } from 'aws-cdk-lib/aws-codepipeline';
import { GitHubSourceAction } from 'aws-cdk-lib/aws-codepipeline-actions';
import { Vpc } from 'aws-cdk-lib/aws-ec2';
import { Repository } from 'aws-cdk-lib/aws-ecr';
import { Cluster, ContainerImage, DeploymentControllerType } from 'aws-cdk-lib/aws-ecs';
import { ApplicationLoadBalancedFargateService } from 'aws-cdk-lib/aws-ecs-patterns';
import { ApplicationTargetGroup, TargetType } from 'aws-cdk-lib/aws-elasticloadbalancingv2';
import { Construct } from 'constructs';
// import * as sqs from 'aws-cdk-lib/aws-sqs';

export class InfraStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    / Create VPC and Fargate Cluster
    // NOTE: Limit AZs to avoid reaching resource quotas
    const vpc = new Vpc(this, 'MyVpc', { maxAzs: 1 });
    const cluster = new Cluster(this, 'Cluster', { vpc });

    const ecrImageRepository = new Repository(this, 'cdk-lb-service-ecr-repo', {
      repositoryName: 'cdk-lb-ecs-service-ecr-repo',
    });

    // Instantiate Fargate Service with just cluster and image
    const fargateLBService = new ApplicationLoadBalancedFargateService(this, "CDKCodeDeployFargateService", {
      cluster,
      deploymentController: {
        type: DeploymentControllerType.CODE_DEPLOY,
      },
      taskImageOptions: {
        image: ContainerImage.fromEcrRepository(ecrImageRepository, 'latest'),
        containerPort: 80
      },
    });

     
    // Creates a new green Target Group
    const targetGroupGreen = new ApplicationTargetGroup(this, "GreenTargetGroup",
      {
        targetGroupName: "alb-green-tg",
        targetType: TargetType.IP,
        port: 80,
        vpc: vpc,
      }
    );

    // CodeBuild project that builds the Docker image
    const buildImage = new Project(this, "BuildImage", {
    buildSpec: BuildSpec.fromSourceFilename("app/buildspec.yaml"),
    source: Source.gitHub({
        owner: "SavvasLearning",
        repo: 'pdf-viewer-bff-service',
        branchOrRef: 'develop',
    }),
    environment: {
        privileged: true,
        environmentVariables: {
        AWS_ACCOUNT_ID: { value: process.env?.CDK_DEFAULT_ACCOUNT || "" },
        REGION: { value: process.env?.CDK_DEFAULT_REGION || "" },
        IMAGE_TAG: { value: "latest" },
        IMAGE_REPO_NAME: { value: ecrImageRepository.repositoryName },
        REPOSITORY_URI: { value: ecrImageRepository.repositoryUri },
        TASK_DEFINITION_ARN: { value: fargateLBService.taskDefinition.taskDefinitionArn },
        TASK_ROLE_ARN: { value: fargateLBService.taskDefinition.taskRole.roleArn },
        EXECUTION_ROLE_ARN: { value: fargateLBService.taskDefinition.executionRole?.roleArn },
        },
    },
    });

    // Creates a new CodeDeploy Deployment Group
    const deploymentGroup = new EcsDeploymentGroup(
      this,
      "CodeDeployGroup",
      {
        service: fargateLBService.service,
        // Configurations for CodeDeploy Blue/Green deployments
        blueGreenDeploymentConfig: {
          blueTargetGroup: fargateLBService.targetGroup,
          greenTargetGroup: targetGroupGreen,
          listener: fargateLBService.listener
        }
      }
    );


    // Creates new pipeline artifacts
    const sourceArtifact = new Artifact("SourceArtifact");
    const buildArtifact = new Artifact("BuildArtifact");

    // Creates the source stage for CodePipeline
    const sourceStage = {
      stageName: "Source",
      actions: [
        new GitHubSourceAction({
          actionName: "AppCodeCommit",
          branch: "main",
          output: sourceArtifact,
          owner: "ckgupta",
          repo: "cdk-lb-ecs-service",
          oauthToken: SecretValue.secretsManager("github_token1"),
        }),
      ],
    };

    // Creates the build stage for CodePipeline
    const buildStage = {
      stageName: "Build",
      actions: [
        new CodeBuildAction({
          actionName: "DockerBuildPush",
          input: new Artifact("SourceArtifact"),
          project: buildImage,
          outputs: [buildArtifact],
        }),
      ],
    };

    // Creates the deploy stage for CodePipeline
    const deployStage = {
      stageName: "Deploy",
      actions: [
        new CodeDeployEcsDeployAction({
          actionName: "EcsFargateDeploy",
          appSpecTemplateInput: buildArtifact,
          taskDefinitionTemplateInput: buildArtifact,
          deploymentGroup: deploymentGroup
        }),
      ],
    };

    // Creates an AWS CodePipeline with source, build, and deploy stages
    new Pipeline(this, "BuildDeployPipeline", {
      pipelineName: "ImageBuildDeployPipeline",
      pipelineType: PipelineType.V2,
      stages: [sourceStage, buildStage, deployStage],
    });

    // Outputs the ALB public endpoint
    new CfnOutput(this, "PublicAlbEndpoint", {
      value: "http://" + fargateLBService.loadBalancer.loadBalancerDnsName,
    });
  }
}
