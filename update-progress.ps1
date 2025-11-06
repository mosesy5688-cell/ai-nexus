# File Path Definitions
$ContextFile = ".\ai-nexus-context.txt"
$ProgressFile = ".\progress-report.txt"

# ----------------------------------------
# 1. Check for prerequisite files
# ----------------------------------------

if (-not (Test-Path $ContextFile) -or -not (Test-Path $ProgressFile)) {
    Write-Error "ERROR: Project Plan (ai-nexus-context.txt) or Progress Report (progress-report.txt) files are missing."
    Write-Error "Please run review-project.ps1 script first to initialize the files."
    exit 1
}

# ----------------------------------------
# 2. Accept user's update instruction (Using built-in $args)
# ----------------------------------------
# Check if instruction is provided via command line arguments
if ($args.Count -eq 0) {
    Write-Error "ERROR: Missing update instruction. Usage: .\update-progress.ps1 'Your instruction here'"
    exit 1
}

# Combine all command line arguments into one instruction string
# This is the variable used in the Gemini prompt: $UpdateInstruction
$UpdateInstruction = $args -join " "

# ----------------------------------------
# 3. Read context and construct Gemini instruction
# ----------------------------------------

$ProjectContext = Get-Content $ContextFile | Out-String
$CurrentProgress = Get-Content $ProgressFile | Out-String

$UpdatePrompt = @"
You are now a dedicated Project Report Update Assistant.
Your sole task is to revise the [Current Progress Report] based on the user's [Update Instruction].
You MUST strictly follow these rules:
1. Output ONLY the complete, updated text content of the [Progress Report].
2. DO NOT include any explanations, greetings, code block delimiters (like ```markdown```), or extra comments outside the report structure.
3. Ensure the output maintains the required Markdown structure (## Headings, - List items) for easy file writing.

--- Project Plan (for context) START ---
$ProjectContext
--- Project Plan (for context) END ---

--- Current Progress Report START ---
$CurrentProgress
--- Current Progress Report END ---

--- User Update Instruction START ---
$UpdateInstruction
--- User Update Instruction END ---

Output the updated [Progress Report] content now:
"@

# ----------------------------------------
# 4. Execute Gemini command and write to file
# ----------------------------------------

Write-Host "Requesting Gemini CLI to update the progress report content..."

# 执行 gemini 命令，获取更新后的报告
$UpdatedContent = gemini "$UpdatePrompt" | Out-String -Stream

# 强制移除可能存在的 Markdown 代码块标记（如 ```markdown）
$CleanContent = $UpdatedContent -replace '```markdown','' -replace '```','' 

if (-not [string]::IsNullOrWhiteSpace($CleanContent)) {
    
    # 写入文件
    $CleanContent | Out-File $ProgressFile -Encoding UTF8 -Force
    
    Write-Host "SUCCESS: Progress Report file ($ProgressFile) has been updated!"
    Write-Host "Instruction used: '$UpdateInstruction'"
} else {
    Write-Error "ERROR: Gemini returned empty content. Progress report NOT updated."
    Write-Error "Please simplify the instruction or check the API connection."
}