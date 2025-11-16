import axios from 'axios';
import cheerio from 'cheerio';

const PWC_TRENDING_URL = 'https://paperswithcode.com/sota';

/**
 * Fetches trending repository URLs from Papers with Code.
 * @returns {Promise<string[]>} A promise that resolves to an array of GitHub repository URLs.
 */
export async function fetchPwCData() {
    console.log('📦 Fetching SOTA repository URLs from Papers with Code...');
    try {
        const { data } = await axios.get(PWC_TRENDING_URL);
        const $ = cheerio.load(data);
        const repoUrls = new Set(); // Use a Set to avoid duplicate URLs

        // Find all links that point to GitHub repositories within the SOTA tables
        $('a[href*="github.com"]').each((i, el) => {
            const href = $(el).attr('href');
            if (href) {
                // Basic validation to ensure it's a repository link
                const urlParts = href.split('/');
                if (urlParts.length >= 5 && urlParts[2] === 'github.com') {
                    // Reconstruct a clean repository URL (e.g., https://github.com/owner/repo)
                    const repoUrl = `https://github.com/${urlParts[3]}/${urlParts[4]}`;
                    repoUrls.add(repoUrl);
                }
            }
        });

        const uniqueUrls = Array.from(repoUrls);
        console.log(`✅ Successfully fetched ${uniqueUrls.length} unique repository URLs from Papers with Code.`);
        return uniqueUrls;
    } catch (error) {
        console.error('❌ Failed to fetch data from Papers with Code:', error.message);
        return [];
    }
}