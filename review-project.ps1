# 文件路径定义
$ContextFile = ".\ai-nexus-context.txt"
$ProgressFile = ".\progress-report.txt"

# 核心功能：检查文件，并在不存在时自动创建

function Ensure-File-Exists ($FilePath, $ContentSource) {
    if (-not (Test-Path $FilePath)) {
        Write-Warning "File '$FilePath' does not exist."
        
        # --- 如果是项目规划文件，创建空白模板 ---
        if ($FilePath -eq $ContextFile) {
            Write-Host "Auto-creating project plan template. Please open this file and paste your full project plan."
            $DefaultContent = @"
# Project Comprehensive Plan (ARCHITECTURE PLAN)
# Please paste your complete project plan content here.
"@
            $DefaultContent | Out-File $FilePath -Encoding UTF8
            exit 
        } 
        
        # --- 如果是进展报告文件，调用 Gemini 生成智能模板 ---
        elseif ($FilePath -eq $ProgressFile) {
            Write-Host "正在调用 Gemini CLI，基于项目规划为您生成报告模板..."

            # 读取项目规划内容
            $ProjectContext = Get-Content $ContextFile | Out-String

            # 构造 Gemini 提示词，要求生成模板
            $TemplatePrompt = @"
            You are a Project Manager. Based on the following project plan, generate a clean progress report template that can be pasted directly into a progress-report.txt file.
            The template must strictly contain these three Markdown sections: ## Completed Milestones, ## In Progress, and ## Major Blockers Encountered.
            Provide specific, stage-relevant examples for each section based on the Project Plan (e.g., domain purchase, Astro setup, script writing).
            Output ONLY the template content. Do not include any explanations or extra markdown delimiters.

            --- Project Plan START ---
            $ProjectContext
            --- Project Plan END ---
            "@

            # 调用 gemini CLI 并将输出保存到文件
            try {
                $GeminiOutput = gemini "$TemplatePrompt" | Out-String -Stream
                $GeminiOutput | Out-File $FilePath -Encoding UTF8
                Write-Host "✅ progress-report.txt 模板已成功生成！请打开文件填写您的项目进展后，再次运行脚本进行审核。"
            }
            catch {
                Write-Error "调用 Gemini CLI 失败。已创建空白模板文件。"
                $FallbackContent = @"
## Completed Milestones
# - [Enter completed tasks here]
## In Progress
# - [Enter ongoing tasks here]
## Major Blockers Encountered
# - [Enter issues encountered here]
"@
                $FallbackContent | Out-File $FilePath -Encoding UTF8
            }
            exit 
        }
    }

# ----------------------------------------
# 1. 确保项目规划文件存在
# ----------------------------------------
Ensure-File-Exists $ContextFile $null 

# 2. 确保进展报告文件存在
Ensure-File-Exists $ProgressFile $ContextFile

# ----------------------------------------
# 3. 执行审核逻辑 (文件存在且已填写)
# ----------------------------------------

# 读取文件内容
$ProjectContext = Get-Content $ContextFile | Out-String
$ProgressContext = Get-Content $ProgressFile | Out-String

# 构造完整的审核请求
$ReviewPrompt = @"
请根据我提供的【项目规划】和【当前进展报告】，进行一次全面的技术和业务审核。

作为一名严格的项目经理和技术架构师，请：
1. **风险评估:** 评估当前进展报告中提到的所有障碍对整体项目时间表和盈利目标的影响。
2. **优先排序:** 提出下一步最具影响力的**三个关键行动点**（Next Steps），并说明为什么。
3. **架构优化:** 审核【项目规划】中是否有任何技术选型或架构存在潜在的单点失败风险或不必要的复杂性，并提出优化建议。

--- 项目完整规划 START ---
$ProjectContext
--- 项目完整规划 END ---

--- 当前进展报告 START ---
$ProgressContext
--- 当前进展报告 END ---
"@

# 执行 gemini 命令，启动项目审核
gemini "$ReviewPrompt"