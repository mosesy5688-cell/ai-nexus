**Free AI Tools** is a full-featured, open-source platform for discovering AI models and tools. Its core mission is to automatically aggregate, process, and display the latest models and tools from major global AI communities. It also leverages AI to generate insightful weekly industry reports, providing a comprehensive and efficient information portal for developers, researchers, and AI enthusiasts.

## 2. Core Features

The website currently has the following core features:

### Multi-Source AI Model Aggregation

*   **Automated Data Flow**: Through a core Node.js script (`scripts/fetch-data.js`), the website automatically fetches the latest AI model and tool data from multiple sources during each build.
*   **Data Sources**:
    *   **HuggingFace**: Fetches popular models via API.
    *   **GitHub**: Searches for repositories with specific topics (e.g., `ai-tool`) via API.
    *   **Civitai**: Reads and parses a pre-prepared `civitai.json` file.
    *   **Replicate**: Scrapes popular models from its explore page using web scraping techniques.
*   **Data Processing**: The script standardizes the raw data fetched, including unifying data structures, filtering NSFW content, deduplicating based on model names, and finally sorting by popularity (e.g., like count).

### AI-Powered Weekly Reports

*   **Gemini-Powered**: Utilizes Google's `gemini-2.5-flash` model to automatically analyze the latest aggregated model data each week.
*   **Intelligent Analysis**: The script constructs a detailed prompt, providing the latest model trends and metadata to Gemini, asking it to generate a weekly report from the perspective of an industry analyst, covering technological breakthroughs, market trends, and more.
*   **Fault Tolerance & Fallback**: The report generation process includes a retry mechanism. If the AI generation fails, the system automatically creates a "fallback report" containing the week's top models, ensuring uninterrupted content.

### Content Exploration & Discovery

*   **Model Detail Pages**: Automatically generates individual static pages (`/model/...`) for each model, displaying detailed information, metadata, tags, and the `README.md` content fetched from the source repository.
*   **Powerful Search & Filtering**: On the `/explore` page, users can perform full-text searches using keywords or filter by clicking on tags (`/keyword/...` or `/explore?tag=...`), and both methods can be combined.
*   **Related Model Recommendations**: On the model detail page, the system intelligently recommends 3 related models based on tag similarity to enhance user discovery and exploration depth.

### Content Archiving

*   **Model Data Archives**: Daily snapshots of model data are stored in `YYYY-MM-DD.json` format in the `src/data/archives/` directory.
*   **Report Archives**: All generated weekly reports (both AI-generated and fallback) are permanently stored in the `src/data/report-archives/` directory and are accessible to users at any time via the `/reports/archive` page.

### SEO & Commercialization Foundation

*   **Deep SEO Optimization**: The website is configured with unique, content-relevant `title` and `description` meta tags for every page (including dynamically generated model, report, and keyword pages) and generates a standard `sitemap.xml`, laying a solid foundation for search engine optimization.
*   **Ad Placement Ready**: Ad slots have been strategically reserved on key pages (like the explore page), preparing for future integration with ad networks like Google AdSense.

## 3. Technical Architecture

The website uses a modern Jamstack architecture with **Astro** as its core framework, achieving excellent performance and maintainability.

*   **Frontend Framework**: **Astro**
    *   **Static Site Generation (SSG)**: The entire site is pre-rendered into static HTML, CSS, and JavaScript at build time, ensuring extremely fast loading speeds, outstanding SEO performance, and high security.
    *   **Component-Based**: Reusable UI components (e.g., `ModelCard.astro`, `ReportCard.astro`) are built using `.astro` files.
    *   **Integrations**: Seamlessly integrates with **Tailwind CSS** for styling.

*   **Data Layer**: **Node.js**
    *   **Core Script**: `scripts/fetch-data.js` is the project's "data engine," responsible for all data-related tasks before each build.
    *   **Key Dependencies**:
        *   `axios`: For making HTTP requests to fetch data from APIs.
        *   `cheerio`: For parsing HTML to enable web scraping of sites like Replicate.
        *   `@google/generative-ai`: For interacting with the Gemini API to generate intelligent weekly reports.
        *   `fs`, `path`: Node.js built-in modules for file system reading/writing and path management.

*   **Data Flow & Storage**
    *   **Data Flow**: External Data Sources → `fetch-data.js` (Fetch, Process, Generate) → `src/data/*.json` → Astro Page Components (Read, Render) → Static HTML Pages.
    *   **Data Storage**: All content data (models, reports, keywords) is stored as `.json` files in the `src/data/` directory. This design separates data from the view, making it easy to manage and version control.

*   **Deployment & Hosting**
    *   **Platform**: Cloudflare Pages.
    *   **Build Command**: `npm run build`, which sequentially executes the data fetching script and Astro's static build command.
    *   **Advantages**: Leverages Cloudflare's global CDN, allowing users to access the site from the nearest node for extremely low latency.

## 4. Project Structure