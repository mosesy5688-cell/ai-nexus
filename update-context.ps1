# File Path Definitions
$ContextFile = ".\ai-nexus-context.txt"

# ----------------------------------------
# 1. Accept user's update instruction
# ----------------------------------------
# 使用内置的 $args 数组获取指令
if ($args.Count -eq 0) {
    Write-Error "ERROR: Missing update instruction. Usage: .\update-context.ps1 'Your instruction here'"
    exit 1
}
$UpdateInstruction = $args -join " "

# ----------------------------------------
# 2. Construct Gemini instruction
# ----------------------------------------
# 读取旧的规划内容作为参考（可选，如果文件为空则跳过）
if (Test-Path $ContextFile) {
    $OldContext = Get-Content $ContextFile | Out-String
} else {
    $OldContext = "# No existing context found."
}

$UpdatePrompt = @"
You are an expert Project Planner and Technical Architect.
Your task is to generate a **complete, new Project Comprehensive Plan** for the 'AI Tools Nexus V2.0' project.

The new plan MUST strictly adhere to these principles (the 'New Mandate'):
1.  **Strategy**: Pivot from 'Quantity/Black-Hat' expansion to **'Quality/White-Hat Authority'** building. Focus on 3-5 core keywords.
2.  **Cost**: The project must be **Zero-Cost** to operate (rely only on free-tier services like GitHub Actions, Cloudflare Pages/KV/Zaraz).
3.  **Monetization**: Strictly **White-Hat and Compliant**. Start with **Google AdSense ONLY**; avoid risky ad networks (Prebid, Adsterra) and methods (exit intent).
4.  **Content**: Content must be **Automated, Unique, and High-Quality** (E-E-A-T). Simplified data sources; **remove Puppeteer/OCR price scraping**.

Base the structure and technical details on the [Previous Context], but ensure all principles in the [New Mandate] are reflected throughout the plan (e.g., in Architecture, Monetization, and SEO sections).

You MUST output **ONLY** the new, complete Project Comprehensive Plan content. Do not include any explanations, greetings, or extra markdown delimiters (like ```markdown```).

--- Previous Context START (for reference) ---
$OldContext
--- Previous Context END ---

Output the NEW, COMPLETE Project Comprehensive Plan now:
"@

# ----------------------------------------
# 3. Execute Gemini command and write to file
# ----------------------------------------

Write-Host "Requesting Gemini CLI to generate a NEW Project Plan based on the White-Hat principles..."

$NewContent = gemini "$UpdatePrompt" | Out-String -Stream

if (-not [string]::IsNullOrWhiteSpace($NewContent)) {
    # 移除可能存在的 Markdown 代码块标记，以确保纯净写入
    $CleanContent = $NewContent -replace '```markdown','' -replace '```','' 
    
    # 写入文件，完全覆盖旧的规划
    $CleanContent | Out-File $ContextFile -Encoding UTF8 -Force
    
    Write-Host "SUCCESS: Project Plan file ($ContextFile) has been completely updated with the White-Hat strategy!"
    Write-Host "You should verify the content."
} else {
    Write-Error "ERROR: Gemini returned empty content. Project Plan NOT updated."
}