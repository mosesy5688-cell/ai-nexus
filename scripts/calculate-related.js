/**
 * Helios V3.0 - Related Models Calculator
 * 算法: 倒排索引 (Inverted Index)
 * 复杂度: O(N) - 极大优于 O(N^2) 的嵌套循环
 */

function calculateRelatedModels(models) {
    console.log(`- [Module] Calculating related models for ${models.length} items using Inverted Index...`);
    const startTime = Date.now();

    // 1. 构建倒排索引 (Tag -> [Model IDs])
    const tagMap = new Map();

    models.forEach(model => {
        let tags = [];
        try {
            // 兼容处理：可能是 JSON 字符串或已经是数组
            tags = typeof model.tags === 'string' ? JSON.parse(model.tags) : model.tags;
        } catch (e) { tags = []; }

        if (Array.isArray(tags)) {
            tags.forEach(tag => {
                if (!tagMap.has(tag)) tagMap.set(tag, []);
                // 只存 ID 和 Likes，减少内存消耗，避免存整个 model 对象
                tagMap.get(tag).push({ id: model.id, likes: model.likes || 0 });
            });
        }
    });

    // 2. 快速查找与评分
    let processedCount = 0;
    models.forEach(model => {
        let tags = [];
        try { tags = typeof model.tags === 'string' ? JSON.parse(model.tags) : model.tags; } catch (e) { }

        if (!Array.isArray(tags) || tags.length === 0) {
            model.related_ids = JSON.stringify([]);
            return;
        }

        const candidates = new Map(); // 使用 Map 自动去重 ID

        // 遍历当前模型的所有标签
        tags.forEach((tag, index) => {
            const siblings = tagMap.get(tag) || [];
            siblings.forEach(sibling => {
                if (sibling.id === model.id) return; // 排除自己

                if (!candidates.has(sibling.id)) {
                    // 评分算法: 
                    // 基础分 = 点赞数
                    // 权重加成 = 如果是第一个标签(通常是主分类)，加 1000 分
                    let score = sibling.likes;
                    if (index === 0) score += 1000;

                    candidates.set(sibling.id, { id: sibling.id, score: score });
                }
            });
        });

        // 取 Top 3，按分数降序排列
        const top3 = Array.from(candidates.values())
            .sort((a, b) => b.score - a.score)
            .slice(0, 3)
            .map(item => item.id);

        model.related_ids = JSON.stringify(top3);
        processedCount++;
    });

    const duration = (Date.now() - startTime) / 1000;
    console.log(`✅ [Module] Related models calculated for ${processedCount} items in ${duration.toFixed(3)}s.`);

    return models;
}

// 导出函数供主脚本调用（ES Module 格式）
export { calculateRelatedModels };
