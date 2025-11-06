export function generateArticleSchema(keyword: string, title: string, description: string) {
  return {
    "@context": "https://schema.org",
    "@type": "TechArticle",
    "headline": title,
    "description": description,
    "author": {
      "@type": "Organization",
      "name": "AI-Nexus"
    },
    "publisher": {
      "@type": "Organization",
      "name": "AI-Nexus",
      "logo": {
        "@type": "ImageObject",
        "url": "https://ai-nexus.dev/logo.png"
      }
    },
    "datePublished": new Date().toISOString(),
    "dateModified": new Date().toISOString()
  };
}
