#!/usr/bin/env bash

# Exit immediately if any command fails
set -e

# Configuration variables
AWS_ACCOUNT_ID="495398516950"
AWS_REGION="ap-south-1"
ECR_REGISTRY="${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
SERVICES=("ingest-api" "worker" "dashboard")
IMAGE_TAG="latest"

# Optional production Vite API URL for dashboard build configuration
# Override this if your production API runs on a different URL/port
VITE_API_URL="http://localhost:3000"

echo -e "\033[0;36m==========================================\033[0m"
echo -e "\033[0;36mStarting AWS ECR DevOps Dashboard Deployment\033[0m"
echo -e "\033[0;36mRegistry: $ECR_REGISTRY\033[0m"
echo -e "\033[0;36mRegion:   $AWS_REGION\033[0m"
echo -e "\033[0;36mTag:      $IMAGE_TAG\033[0m"
echo -e "\033[0;36m==========================================\033[0m"

# Step 1: Authenticate Docker to AWS ECR
echo -e "\n\033[0;32m[Step 1] Authenticating Docker with AWS ECR...\033[0m"
aws ecr get-login-password --region "$AWS_REGION" | docker login --username AWS --password-stdin "$ECR_REGISTRY"

# Step 2: Loop through services to check repo, build, tag, and push
for service in "${SERVICES[@]}"; do
    repoName="devops-dashboard-$service"
    echo -e "\n\033[0;33m------------------------------------------\033[0m"
    echo -e "\033[0;33mProcessing Service: $service\033[0m"
    echo -e "\033[0;33m------------------------------------------\033[0m"

    # A: Create ECR Repository if it doesn't exist
    echo -e "\033[0;90mChecking if ECR Repository '$repoName' exists...\033[0m"
    if aws ecr describe-repositories --repository-names "$repoName" --region "$AWS_REGION" >/dev/null 2>&1; then
        echo -e "\033[0;90mECR Repository '$repoName' already exists.\033[0m"
    else
        echo -e "\033[0;35mECR Repository '$repoName' not found. Creating repository...\033[0m"
        aws ecr create-repository --repository-name "$repoName" --region "$AWS_REGION" --image-scanning-configuration scanOnPush=true >/dev/null
        echo -e "\033[0;35mSuccessfully created ECR Repository '$repoName'.\033[0m"
    fi

    # B: Build Docker Image
    echo -e "\033[0;34mBuilding Docker image for '$service'...\033[0m"
    if [ "$service" = "dashboard" ]; then
        # Dashboard requires VITE_API_URL build argument
        docker build --build-arg VITE_API_URL="$VITE_API_URL" -t "$repoName" ./"$service"
    else
        docker build -t "$repoName" ./"$service"
    fi

    # C: Tag Docker Image
    targetTag="${ECR_REGISTRY}/${repoName}:${IMAGE_TAG}"
    echo -e "\033[0;34mTagging image: $repoName -> $targetTag\033[0m"
    docker tag "${repoName}:latest" "$targetTag"

    # D: Push Docker Image to ECR
    echo -e "\033[0;34mPushing image to ECR...\033[0m"
    docker push "$targetTag"
done

echo -e "\n\033[0;36m==========================================\033[0m"
echo -e "\033[0;36mDeployment Completed Successfully!\033[0m"
echo -e "\033[0;36m==========================================\033[0m"
