# File Path Definitions
$ContextFile = ".\ai-nexus-context.txt"
$ProgressFile = ".\progress-report.txt"

# ----------------------------------------
# 1. Accept user's instruction and target file (Using built-in $args)
# ----------------------------------------
if ($args.Count -lt 2) {
    Write-Error "ERROR: Missing arguments. Usage: .\code-optimize.ps1 <TargetFile> '<OptimizationGoal>'"
    exit 1
}

# TargetFile is the first argument ($args[0])
$TargetFile = $args[0]

# OptimizationGoal is the second argument, joined in case it has spaces ($args[1] onward)
$OptimizationGoal = $args[1..($args.Count - 1)] -join " "
# ----------------------------------------
# 2. Check for prerequisite files
# ----------------------------------------

if (-not (Test-Path $ContextFile) -or -not (Test-Path $ProgressFile)) {
    Write-Error "ERROR: Project Plan or Progress Report files are missing."
    exit 1
}

if (-not (Test-Path $TargetFile)) {
    Write-Error "ERROR: Target file '$TargetFile' not found. Please check the path."
    exit 1
}

# ----------------------------------------
# 3. Read context and construct Gemini instruction
# ----------------------------------------

$ProjectContext = Get-Content $ContextFile | Out-String
$CurrentProgress = Get-Content $ProgressFile | Out-String
$CurrentCode = Get-Content $TargetFile | Out-String

$UpdatePrompt = @"
You are now a dedicated Project Architect and Code Reviewer.
Your task is to review and/or optimize the [Target Code] based on the project's [New Context] and the user's [Optimization Goal].

You MUST output your response in TWO distinct parts:

### 1. Code Output (The Optimized Code)
Output the COMPLETE, optimized content for the target file '$TargetFile'. Enclose this code block in the correct markdown language delimiter (e.g., ```javascript...```). If you are generating a new file, output the complete new code. If no code change is needed, output: ```text No code change required. ```

### 2. Implementation Guide (Instructions for the User)
Provide a clear, single-line summary of the code change, which the user can use directly as their Git commit message.

--- Project Context START ---
$ProjectContext
--- Project Context END ---

--- Current Progress START ---
$CurrentProgress
--- Current Progress END ---

--- Target File: $TargetFile Code START ---
$CurrentCode
--- Target File: $TargetFile Code END ---

--- Optimization Goal START ---
$OptimizationGoal
--- Optimization Goal END ---

Generate the response now:
"@

# ----------------------------------------
# 4. Execute Gemini command and process output
# ----------------------------------------

Write-Host "Requesting Gemini CLI to optimize '$TargetFile' based on the project mandate..."
$GeminiOutput = gemini "$UpdatePrompt" | Out-String -Stream

# Display Gemini's output (Code and Git Instructions)
Write-Host "--- Gemini Optimization Result START ---"
Write-Host $GeminiOutput
Write-Host "--- Gemini Optimization Result END ---"

# ----------------------------------------
# 5. Provide Push Instructions and Auto-Update Progress
# ----------------------------------------

if ($GeminiOutput -match "### 2\. Implementation Guide\s*([\s\S]*?)\s*--- Gemini Optimization Result END ---") {
    $CommitMessage = ($Matches[1].Trim() -split "`n")[0].Trim()
} else {
    $CommitMessage = "chore: Applied code review and optimization for '$TargetFile'."
}

Write-Host "`n======================================================="
Write-Host "               ACTION REQUIRED: PUSH TO GITHUB"
Write-Host "======================================================="
Write-Host "1. MANUAL STEP: Open '$TargetFile' and replace its content with the code from '1. Code Output' above."
Write-Host "2. EXECUTE GIT COMMANDS (You must run these manually in your terminal):"
Write-Host "   git add ."
Write-Host "   git commit -m '$CommitMessage'"
Write-Host "   git push"
Write-Host "-------------------------------------------------------"
Write-Host "3. AUTO-UPDATE PROGRESS: Once the push is successful, run the following command to log the change:"
Write-Host "`n.\update-progress.ps1 \"Completed code optimization and deployment for $TargetFile. Used commit message: '$CommitMessage'\""
Write-Host "======================================================="