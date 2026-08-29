# Ensure script exits if any command fails
$ErrorActionPreference = "Stop"

# Configuration variables
$AWS_ACCOUNT_ID = "495398516950"
$AWS_REGION = "ap-south-1"
$ECR_REGISTRY = "${AWS_ACCOUNT_ID}.dkr.ecr.${AWS_REGION}.amazonaws.com"
$SERVICES = @("ingest-api", "worker", "dashboard")
$IMAGE_TAG = "latest"

# Optional production Vite API URL for dashboard build configuration
# Override this if your production API runs on a different URL/port
$VITE_API_URL = "http://localhost:3000"

Write-Host "==========================================" -ForegroundColor Cyan
Write-Host "Starting AWS ECR DevOps Dashboard Deployment" -ForegroundColor Cyan
Write-Host "Registry: $ECR_REGISTRY" -ForegroundColor Cyan
Write-Host "Region:   $AWS_REGION" -ForegroundColor Cyan
Write-Host "Tag:      $IMAGE_TAG" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan

# Step 1: Authenticate Docker to AWS ECR
Write-Host "`n[Step 1] Authenticating Docker with AWS ECR..." -ForegroundColor Green
aws ecr get-login-password --region $AWS_REGION | docker login --username AWS --password-stdin $ECR_REGISTRY

# Step 2: Loop through services to check repo, build, tag, and push
foreach ($service in $SERVICES) {
    $repoName = "devops-dashboard-$service"
    Write-Host "`n------------------------------------------" -ForegroundColor Yellow
    Write-Host "Processing Service: $service" -ForegroundColor Yellow
    Write-Host "------------------------------------------" -ForegroundColor Yellow

    # A: Create ECR Repository if it doesn't exist
    Write-Host "Checking if ECR Repository '$repoName' exists..." -ForegroundColor Gray
    try {
        # Run describe command. Redirect error stream to catch exception if repository is missing.
        aws ecr describe-repositories --repository-names $repoName --region $AWS_REGION > $null 2>&1
        Write-Host "ECR Repository '$repoName' already exists." -ForegroundColor Gray
    } catch {
        # If the repository is not found, command throws error; create the repository
        Write-Host "ECR Repository '$repoName' not found. Creating repository..." -ForegroundColor Magenta
        aws ecr create-repository --repository-name $repoName --region $AWS_REGION --image-scanning-configuration scanOnPush=true > $null
        Write-Host "Successfully created ECR Repository '$repoName'." -ForegroundColor Magenta
    }

    # B: Build Docker Image
    Write-Host "Building Docker image for '$service'..." -ForegroundColor Blue
    if ($service -eq "dashboard") {
        # Dashboard requires VITE_API_URL build argument
        docker build --build-arg VITE_API_URL=$VITE_API_URL -t $repoName ./$service
    } else {
        docker build -t $repoName ./$service
    }
    
    # C: Tag Docker Image
    $targetTag = "${ECR_REGISTRY}/${repoName}:${IMAGE_TAG}"
    Write-Host "Tagging image: $repoName -> $targetTag" -ForegroundColor Blue
    docker tag "${repoName}:latest" $targetTag

    # D: Push Docker Image to ECR
    Write-Host "Pushing image to ECR..." -ForegroundColor Blue
    docker push $targetTag
}

Write-Host "`n==========================================" -ForegroundColor Cyan
Write-Host "Deployment Completed Successfully!" -ForegroundColor Cyan
Write-Host "==========================================" -ForegroundColor Cyan
