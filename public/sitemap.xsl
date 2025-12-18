<?xml version="1.0" encoding="UTF-8"?>
<!--
  Free2AITools Sitemap Stylesheet
  Makes XML sitemaps human-readable for debugging
  V6.1+ SEO Optimization
-->
<xsl:stylesheet version="2.0" 
                xmlns:html="http://www.w3.org/TR/REC-html40"
                xmlns:sitemap="http://www.sitemaps.org/schemas/sitemap/0.9"
                xmlns:xsl="http://www.w3.org/1999/XSL/Transform">
  <xsl:output method="html" version="1.0" encoding="UTF-8" indent="yes"/>
  
  <xsl:template match="/">
    <html xmlns="http://www.w3.org/1999/xhtml">
      <head>
        <title>Free2AITools Sitemap</title>
        <meta charset="UTF-8"/>
        <meta name="viewport" content="width=device-width, initial-scale=1"/>
        <style type="text/css">
          * { box-sizing: border-box; }
          body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
            color: #1a1a2e; 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            min-height: 100vh;
            padding: 20px;
            margin: 0;
          }
          .container {
            max-width: 1200px;
            margin: 0 auto;
            background: rgba(255,255,255,0.95);
            border-radius: 16px;
            padding: 30px;
            box-shadow: 0 20px 60px rgba(0,0,0,0.2);
          }
          .header { 
            text-align: center;
            margin-bottom: 30px;
            padding-bottom: 20px;
            border-bottom: 2px solid #f0f0f0;
          }
          h1 {
            font-size: 2rem;
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            -webkit-background-clip: text;
            -webkit-text-fill-color: transparent;
            background-clip: text;
            margin: 0 0 10px 0;
          }
          .subtitle {
            color: #666;
            font-size: 0.95rem;
          }
          .stats {
            display: flex;
            gap: 20px;
            justify-content: center;
            margin-top: 15px;
          }
          .stat {
            background: #f8f9fa;
            padding: 10px 20px;
            border-radius: 8px;
            font-weight: 600;
          }
          .stat-value {
            color: #667eea;
          }
          table { 
            border-collapse: collapse; 
            width: 100%; 
            margin-top: 20px;
            font-size: 0.9rem;
          }
          th, td { 
            text-align: left; 
            padding: 12px 16px; 
            border-bottom: 1px solid #eee; 
          }
          th { 
            background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
            color: white;
            font-weight: 600;
            position: sticky;
            top: 0;
          }
          tr:hover { background-color: #f8f9fa; }
          a { 
            color: #667eea; 
            text-decoration: none;
            word-break: break-all;
          }
          a:hover { text-decoration: underline; }
          .priority-high { color: #10b981; font-weight: 600; }
          .priority-mid { color: #f59e0b; }
          .priority-low { color: #6b7280; }
          .badge {
            display: inline-block;
            padding: 4px 8px;
            border-radius: 4px;
            font-size: 0.8rem;
            font-weight: 500;
          }
          .badge-daily { background: #dcfce7; color: #166534; }
          .badge-weekly { background: #fef3c7; color: #92400e; }
          .badge-monthly { background: #e0e7ff; color: #3730a3; }
          .footer {
            margin-top: 30px;
            padding-top: 20px;
            border-top: 2px solid #f0f0f0;
            text-align: center;
            color: #666;
            font-size: 0.85rem;
          }
        </style>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <h1>🗺️ Free2AITools Sitemap</h1>
            <p class="subtitle">System-generated sitemap for search engines</p>
            <div class="stats">
              <xsl:if test="count(sitemap:sitemapindex/sitemap:sitemap) > 0">
                <div class="stat">
                  <span class="stat-value"><xsl:value-of select="count(sitemap:sitemapindex/sitemap:sitemap)"/></span> Sitemaps
                </div>
              </xsl:if>
              <xsl:if test="count(sitemap:urlset/sitemap:url) > 0">
                <div class="stat">
                  <span class="stat-value"><xsl:value-of select="count(sitemap:urlset/sitemap:url)"/></span> URLs
                </div>
              </xsl:if>
            </div>
          </div>
          
          <!-- Sitemap Index View -->
          <xsl:if test="count(sitemap:sitemapindex/sitemap:sitemap) > 0">
            <table>
              <thead>
                <tr>
                  <th>Sitemap URL</th>
                  <th>Last Modified</th>
                </tr>
              </thead>
              <tbody>
                <xsl:for-each select="sitemap:sitemapindex/sitemap:sitemap">
                  <tr>
                    <td><a href="{sitemap:loc}"><xsl:value-of select="sitemap:loc"/></a></td>
                    <td><xsl:value-of select="sitemap:lastmod"/></td>
                  </tr>
                </xsl:for-each>
              </tbody>
            </table>
          </xsl:if>
          
          <!-- URL Set View -->
          <xsl:if test="count(sitemap:urlset/sitemap:url) > 0">
            <table>
              <thead>
                <tr>
                  <th>Location</th>
                  <th>Priority</th>
                  <th>Frequency</th>
                  <th>Last Modified</th>
                </tr>
              </thead>
              <tbody>
                <xsl:for-each select="sitemap:urlset/sitemap:url">
                  <tr>
                    <td><a href="{sitemap:loc}"><xsl:value-of select="sitemap:loc"/></a></td>
                    <td>
                      <xsl:choose>
                        <xsl:when test="sitemap:priority >= 0.8">
                          <span class="priority-high"><xsl:value-of select="sitemap:priority"/></span>
                        </xsl:when>
                        <xsl:when test="sitemap:priority >= 0.5">
                          <span class="priority-mid"><xsl:value-of select="sitemap:priority"/></span>
                        </xsl:when>
                        <xsl:otherwise>
                          <span class="priority-low"><xsl:value-of select="sitemap:priority"/></span>
                        </xsl:otherwise>
                      </xsl:choose>
                    </td>
                    <td>
                      <xsl:choose>
                        <xsl:when test="sitemap:changefreq = 'daily'">
                          <span class="badge badge-daily"><xsl:value-of select="sitemap:changefreq"/></span>
                        </xsl:when>
                        <xsl:when test="sitemap:changefreq = 'weekly'">
                          <span class="badge badge-weekly"><xsl:value-of select="sitemap:changefreq"/></span>
                        </xsl:when>
                        <xsl:otherwise>
                          <span class="badge badge-monthly"><xsl:value-of select="sitemap:changefreq"/></span>
                        </xsl:otherwise>
                      </xsl:choose>
                    </td>
                    <td><xsl:value-of select="sitemap:lastmod"/></td>
                  </tr>
                </xsl:for-each>
              </tbody>
            </table>
          </xsl:if>
          
          <div class="footer">
            <p>Generated by Free2AITools L8 Precompute | Constitution Art 6.3 Compliant</p>
            <p>For search engine use. <a href="https://free2aitools.com">Return to site →</a></p>
          </div>
        </div>
      </body>
    </html>
  </xsl:template>
</xsl:stylesheet>
