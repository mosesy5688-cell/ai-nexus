$ScriptContent = @'
# File Path Definitions
$ContextFile = ".\ai-nexus-context.txt"
$ProgressFile = ".\progress-report.txt"
# Core function: Check for file existence and create if missing
function Ensure-File-Exists ($FilePath, $ContentSource) {
    if (-not (Test-Path $FilePath)) {
        Write-Warning "File '$FilePath' does not exist."
        
                # --- Create Project Context File ---
        if ($FilePath -eq $ContextFile) {
            Write-Host "Auto-creating project plan template. Please open this file and paste your full project plan."
            $DefaultContent = @"
# Project Comprehensive Plan (ARCHITECTURE PLAN)
# Please paste your complete project plan content here.
"@
            $DefaultContent | Out-File $FilePath -Encoding UTF8
            exit 
        } 
        
        # --- Create Progress Report File (Using Gemini) ---
        elseif ($FilePath -eq $ProgressFile) {
            Write-Host "Calling Gemini CLI to generate a report template based on the project plan..."

            # Read Project Context
            $ProjectContext = Get-Content $ContextFile | Out-String

            # Construct Gemini Prompt to generate the template
            $TemplatePrompt = @"
            You are a Project Manager. Based on the following project plan, generate a clean progress report template that can be pasted directly into a progress-report.txt file.
            The template must strictly contain these three Markdown sections: ## Completed Milestones, ## In Progress, and ## Major Blockers Encountered.
            Provide specific, stage-relevant examples for each section based on the Project Plan (e.g., domain purchase, Astro setup, script writing).
            Output ONLY the template content. Do not include any explanations or extra markdown delimiters.

            --- Project Plan START ---
            $ProjectContext
            --- Project Plan END ---
            "@

            # Execute gemini CLI and save output
            try {
                $GeminiOutput = gemini "$TemplatePrompt" | Out-String -Stream
                $GeminiOutput | Out-File $FilePath -Encoding UTF8
                Write-Host "SUCCESS: progress-report.txt template generated! Fill it in, then run the script again."
            }
            catch {
                Write-Error "Gemini CLI call failed. Creating a blank fallback template."
                $FallbackContent = @"
## Completed Milestones
# - [Enter completed tasks here]
## In Progress
# - [Enter ongoing tasks here]
## Major Blockers Encountered
# - [Enter issues encountered here]
                $FallbackContent | Out-File $FilePath -Encoding UTF8
            }
            exit 
        }
    }
}
'@