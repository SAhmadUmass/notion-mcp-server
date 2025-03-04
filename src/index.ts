import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@notionhq/client";
import { z } from "zod";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";
import axios from "axios";
import * as cheerio from "cheerio";

// Load environment variables from .env file
try {
  // Try to find .env file in the current directory or parent directories
  const envPath = path.resolve(process.cwd(), '.env');
  if (fs.existsSync(envPath)) {
    dotenv.config({ path: envPath });
  }
} catch (error) {
  // Silently continue if .env file can't be loaded
}

// Get API key from environment or command line arguments
const NOTION_API_KEY = process.env.NOTION_API_KEY || process.argv.find(arg => arg.startsWith('--notion-api-key='))?.split('=')[1];

if (!NOTION_API_KEY) {
  process.stderr.write("Error: NOTION_API_KEY not set. Please set it in .env file or pass as --notion-api-key=YOUR_KEY\n");
  process.exit(1);
}

// Initialize Notion client
const notion = new Client({
  auth: NOTION_API_KEY
});

// Create the MCP server
const server = new McpServer({
  name: "notion-server",
  version: "1.0.0"
});

// Tool: Search Notion
server.tool(
  "search-notion",
  { query: z.string() },
  async ({ query }) => {
    try {
      const results = await notion.search({
        query,
        sort: {
          direction: "descending",
          timestamp: "last_edited_time"
        },
      });
      
      // Format the results nicely
      const formattedResults = results.results.map((item: any) => {
        // Safely extract title based on the item type
        let title = "Untitled";
        if (item.object === "page" && item.properties) {
          // Try to find title in various typical properties
          const titleProp = item.properties.title || item.properties.Name;
          if (titleProp?.title?.[0]?.plain_text) {
            title = titleProp.title[0].plain_text;
          }
        }
        
        return {
          id: item.id,
          title,
          url: item.url || "",
          type: item.object,
          last_edited: item.last_edited_time
        };
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(formattedResults, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `Error searching Notion: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Tool: Get Notion Page
server.tool(
  "get-page",
  { pageId: z.string() },
  async ({ pageId }) => {
    try {
      // Get the page
      const page = await notion.pages.retrieve({ page_id: pageId });
      
      // Get page blocks (content)
      const blocks = await notion.blocks.children.list({ block_id: pageId });
      
      // Extract text from blocks
      const content = blocks.results.map((block: any) => {
        if (block.type === 'paragraph') {
          return block.paragraph.rich_text.map((text: any) => text.plain_text).join('');
        }
        if (block.type === 'heading_1') {
          return `# ${block.heading_1.rich_text.map((text: any) => text.plain_text).join('')}`;
        }
        if (block.type === 'heading_2') {
          return `## ${block.heading_2.rich_text.map((text: any) => text.plain_text).join('')}`;
        }
        if (block.type === 'heading_3') {
          return `### ${block.heading_3.rich_text.map((text: any) => text.plain_text).join('')}`;
        }
        if (block.type === 'bulleted_list_item') {
          return `• ${block.bulleted_list_item.rich_text.map((text: any) => text.plain_text).join('')}`;
        }
        if (block.type === 'numbered_list_item') {
          return `1. ${block.numbered_list_item.rich_text.map((text: any) => text.plain_text).join('')}`;
        }
        return '';
      }).filter(Boolean).join('\n\n');
      
      // Safely extract title from page
      let titleText = 'Untitled';
      
      // Type assertion to access properties as any
      const pageAny = page as any;
      if (pageAny.properties) {
        // Find the first property that's a title
        const titleProp = Object.values(pageAny.properties).find(
          (prop: any) => prop.type === 'title'
        ) as any;
        
        if (titleProp?.title?.[0]?.plain_text) {
          titleText = titleProp.title[0].plain_text;
        }
      }
      
      return {
        content: [{
          type: "text",
          text: `# ${titleText}\n\n${content}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `Error retrieving page: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Tool: Create a Notion page
server.tool(
  "create-page",
  { 
    parentId: z.string().optional(),
    title: z.string(),
    content: z.string()
  },
  async ({ parentId, title, content }) => {
    try {
      // Set parent according to Notion API requirements
      const parent = parentId 
        ? { page_id: parentId, type: "page_id" as const }
        : { database_id: process.env.NOTION_DATABASE_ID || "", type: "database_id" as const };
      
      // If no parent ID and no database ID, error out with instructions
      if (!parentId && !process.env.NOTION_DATABASE_ID) {
        return {
          content: [{
            type: "text",
            text: `Error: To create a page, you must either provide a parentId or set NOTION_DATABASE_ID in your .env file.`
          }],
          isError: true
        };
      }
      
      const response = await notion.pages.create({
        parent,
        properties: {
          title: {
            title: [{ text: { content: title } }]
          }
        },
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content } }]
            }
          }
        ]
      });
      
      // Use id directly since url property might not be available in all response types
      return {
        content: [{
          type: "text",
          text: `Page created successfully!\nTitle: ${title}\nID: ${response.id}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `Error creating page: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Tool: Update a Notion page
server.tool(
  "update-page",
  { 
    pageId: z.string(),
    title: z.string().optional(),
    content: z.string()
  },
  async ({ pageId, title, content }) => {
    try {
      // Update page properties (title) if provided
      if (title) {
        await notion.pages.update({
          page_id: pageId,
          properties: {
            title: {
              title: [{ text: { content: title } }]
            }
          }
        });
      }
      
      // Add new content as a paragraph block
      await notion.blocks.children.append({
        block_id: pageId,
        children: [
          {
            object: "block",
            type: "paragraph",
            paragraph: {
              rich_text: [{ type: "text", text: { content } }]
            }
          }
        ]
      });
      
      return {
        content: [{
          type: "text",
          text: `Page updated successfully!\nID: ${pageId}${title ? `\nTitle: ${title}` : ''}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `Error updating page: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Tool: Create a Notion database
server.tool(
  "create-database",
  { 
    parentPageId: z.string(),
    title: z.string(),
    properties: z.record(z.any())
  },
  async ({ parentPageId, title, properties }) => {
    try {
      const response = await notion.databases.create({
        parent: {
          type: "page_id",
          page_id: parentPageId
        },
        title: [
          {
            type: "text",
            text: {
              content: title
            }
          }
        ],
        properties: properties
      });
      
      return {
        content: [{
          type: "text",
          text: `Database created successfully!\nTitle: ${title}\nID: ${response.id}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `Error creating database: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Tool: Query a Notion database
server.tool(
  "query-database",
  { 
    databaseId: z.string(),
    filter: z.any().optional(),
    sort: z.any().optional()
  },
  async ({ databaseId, filter, sort }) => {
    try {
      // Prepare query parameters
      const queryParams: any = {
        database_id: databaseId
      };
      
      // Add filter if provided
      if (filter) {
        queryParams.filter = filter;
      }
      
      // Add sort if provided
      if (sort) {
        queryParams.sorts = sort;
      }
      
      // Query the database
      const response = await notion.databases.query(queryParams);
      
      // Format the results
      const formattedResults = response.results.map((page: any) => {
        // Extract properties in a more readable format
        const formattedProperties: any = {};
        
        Object.entries(page.properties).forEach(([key, value]: [string, any]) => {
          // Handle different property types
          switch (value.type) {
            case 'title':
              formattedProperties[key] = value.title.map((t: any) => t.plain_text).join('');
              break;
            case 'rich_text':
              formattedProperties[key] = value.rich_text.map((t: any) => t.plain_text).join('');
              break;
            case 'number':
              formattedProperties[key] = value.number;
              break;
            case 'select':
              formattedProperties[key] = value.select?.name || null;
              break;
            case 'multi_select':
              formattedProperties[key] = value.multi_select.map((s: any) => s.name);
              break;
            case 'date':
              formattedProperties[key] = value.date?.start || null;
              break;
            case 'checkbox':
              formattedProperties[key] = value.checkbox;
              break;
            case 'url':
              formattedProperties[key] = value.url;
              break;
            case 'email':
              formattedProperties[key] = value.email;
              break;
            case 'phone_number':
              formattedProperties[key] = value.phone_number;
              break;
            default:
              formattedProperties[key] = 'Unsupported property type: ' + value.type;
          }
        });
        
        return {
          id: page.id,
          properties: formattedProperties
        };
      });
      
      return {
        content: [{
          type: "text",
          text: JSON.stringify(formattedResults, null, 2)
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `Error querying database: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Tool: Update a database entry
server.tool(
  "update-database-entry",
  { 
    pageId: z.string(),
    properties: z.record(z.any())
  },
  async ({ pageId, properties }) => {
    try {
      // Update the page properties (database entry)
      const response = await notion.pages.update({
        page_id: pageId,
        properties: properties
      });
      
      return {
        content: [{
          type: "text",
          text: `Database entry updated successfully!\nID: ${response.id}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `Error updating database entry: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Tool: Create a database row (entry)
server.tool(
  "create-database-row",
  { 
    databaseId: z.string(),
    properties: z.record(z.any())
  },
  async ({ databaseId, properties }) => {
    try {
      // Create a new page (row) in the database
      const response = await notion.pages.create({
        parent: {
          database_id: databaseId,
          type: "database_id"
        },
        properties: properties
      });
      
      return {
        content: [{
          type: "text",
          text: `Database row created successfully!\nID: ${response.id}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `Error creating database row: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Tool: Extract metadata from URLs in a database
server.tool(
  "extract-url-metadata",
  { 
    databaseId: z.string(),
    urlPropertyName: z.string().optional(),
    publicationPropertyName: z.string().optional(),
    authorPropertyName: z.string().optional(),
    datePropertyName: z.string().optional(),
    summaryPropertyName: z.string().optional(),
    batchSize: z.number().default(5),
    limit: z.number().default(50),
    generateSummary: z.boolean().default(true)
  },
  async ({ 
    databaseId, 
    urlPropertyName, 
    publicationPropertyName, 
    authorPropertyName, 
    datePropertyName, 
    summaryPropertyName,
    batchSize,
    limit,
    generateSummary
  }) => {
    try {
      // First retrieve database to get property types
      const databaseInfo = await notion.databases.retrieve({
        database_id: databaseId
      });
      
      // Get all available property names and types
      const propertyInfoMap = databaseInfo.properties || {};
      
      // Auto-detect or use specified property names
      const urlPropertyName2 = urlPropertyName || findMatchingProperty(propertyInfoMap, [
        "URL", "Link", "Website", "Address", "Source Link"
      ]);
      
      const publicationProperty = publicationPropertyName || findMatchingProperty(propertyInfoMap, [
        "Publication", "Publisher", "Source", "Site", "Website Name", "Origin"
      ]);
      
      const authorProperty = authorPropertyName || findMatchingProperty(propertyInfoMap, [
        "Author", "Author(s)", "Writer", "Creator", "By"
      ]);
      
      const dateProperty = datePropertyName || findMatchingProperty(propertyInfoMap, [
        "Date", "Published", "Published Date", "Publish Date", "Release Date", "Post Date"
      ]);
      
      const summaryProperty = summaryPropertyName || findMatchingProperty(propertyInfoMap, [
        "Summary", "Article Summary", "TLDR", "Description", "Brief"
      ]);
      
      // Get property types for the detected properties
      const publicationPropertyType = getPropertyType(propertyInfoMap, publicationProperty);
      const authorPropertyType = getPropertyType(propertyInfoMap, authorProperty);
      const datePropertyType = getPropertyType(propertyInfoMap, dateProperty);
      const summaryPropertyType = getPropertyType(propertyInfoMap, summaryProperty);
      
      // Query the database to get rows with URLs
      const response = await notion.databases.query({
        database_id: databaseId,
        page_size: limit
      });
      
      const results: string[] = [];
      let successCount = 0;
      let failureCount = 0;
      
      // Log the property mapping being used
      results.push(`Using field mapping:
- URLs: "${urlPropertyName2}" (${getPropertyType(propertyInfoMap, urlPropertyName2)})
- Publication: "${publicationProperty}" (${publicationPropertyType})
- Author: "${authorProperty}" (${authorPropertyType})
- Date: "${dateProperty}" (${datePropertyType})
- Summary: "${summaryProperty}" (${summaryPropertyType})`);
      
      // Process rows in batches
      for (let i = 0; i < response.results.length; i += batchSize) {
        const batch = response.results.slice(i, i + batchSize);
        
        // Process each row in the batch concurrently
        const batchPromises = batch.map(async (page: any) => {
          try {
            // Extract URL from the specified property
            const urlPropertyValue = page.properties[urlPropertyName2];
            let url = null;
            
            // Handle different property types that could contain URLs
            if (urlPropertyValue?.type === 'url' && urlPropertyValue.url) {
              url = urlPropertyValue.url;
            } else if (urlPropertyValue?.type === 'rich_text' && urlPropertyValue.rich_text.length > 0) {
              url = urlPropertyValue.rich_text[0]?.plain_text;
            } else if (urlPropertyValue?.type === 'title' && urlPropertyValue.title.length > 0) {
              url = urlPropertyValue.title[0]?.plain_text;
            }
            
            if (!url || !url.startsWith('http')) {
              return `Row ${page.id}: No valid URL found in property "${urlPropertyName2}"`;
            }
            
            // Fetch and extract metadata
            const metadata = await extractMetadataFromUrl(url);
            
            // Update the row with extracted metadata
            const properties: any = {};
            
            // Handle publication based on property type
            if (metadata.publication && publicationPropertyType) {
              if (publicationPropertyType === 'select') {
                properties[publicationProperty] = createSelectProperty(metadata.publication);
              } else if (publicationPropertyType === 'rich_text') {
                properties[publicationProperty] = createRichTextProperty(metadata.publication);
              } else if (publicationPropertyType === 'title') {
                properties[publicationProperty] = createTitleProperty(metadata.publication);
              }
            }
            
            // Handle author based on property type
            if (metadata.author && authorPropertyType) {
              if (authorPropertyType === 'multi_select') {
                properties[authorProperty] = createMultiSelectProperty(parseAuthors(metadata.author));
              } else if (authorPropertyType === 'select') {
                properties[authorProperty] = createSelectProperty(metadata.author);
              } else if (authorPropertyType === 'rich_text') {
                properties[authorProperty] = createRichTextProperty(metadata.author);
              }
            }
            
            // Handle date based on property type
            if (metadata.date && datePropertyType === 'date') {
              properties[dateProperty] = createDateProperty(metadata.date);
            }
            
            // Get content for page update and summary generation
            let content = metadata.content || '';
            let summary = '';
            
            // Generate summary using extracted content
            if (content && generateSummary && summaryPropertyType) {
              // For now, use a simple summarization method
              summary = createSimpleSummary(content);
              
              // Add summary to properties based on property type
              if (summaryPropertyType === 'rich_text') {
                properties[summaryProperty] = createRichTextProperty(summary);
              } else if (summaryPropertyType === 'select') {
                properties[summaryProperty] = createSelectProperty(summary);
              } else if (summaryPropertyType === 'multi_select') {
                properties[summaryProperty] = createMultiSelectProperty([summary]);
              }
            }
            
            // Update the page properties
            if (Object.keys(properties).length > 0) {
              await notion.pages.update({
                page_id: page.id,
                properties: properties
              });
            }
            
            // Update the page content if we have content and it's not already in the page
            if (content) {
              // Get existing blocks
              const blocks = await notion.blocks.children.list({
                block_id: page.id
              });
              
              // Only update if there are no blocks or fewer than 3 (assuming just a title)
              if (blocks.results.length < 3) {
                // Create content blocks (paragraphs)
                const contentBlocks = createContentBlocks(content);
                
                await notion.blocks.children.append({
                  block_id: page.id,
                  children: contentBlocks
                });
              }
            }
            
            successCount++;
            return `Row ${page.id}: Successfully extracted metadata from ${url}`;
          } catch (error: any) {
            failureCount++;
            return `Row ${page.id}: Failed to extract metadata - ${error.message}`;
          }
        });
        
        // Wait for all pages in the batch to be processed
        const batchResults = await Promise.all(batchPromises);
        results.push(...batchResults);
        
        // Add a small delay between batches to avoid rate limiting
        if (i + batchSize < response.results.length) {
          await new Promise(resolve => setTimeout(resolve, 1000));
        }
      }
      
      return {
        content: [{
          type: "text",
          text: `Processed ${successCount + failureCount} URLs\n${successCount} successful\n${failureCount} failed\n\nDetails:\n${results.join('\n')}`
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `Error extracting metadata: ${error.message}`
        }],
        isError: true
      };
    }
  }
);

// Helper function to find a matching property from available properties
function findMatchingProperty(propertyInfoMap: any, possibleNames: string[]): string {
  const availableProperties = Object.keys(propertyInfoMap);
  
  // First try exact match
  for (const name of possibleNames) {
    if (availableProperties.includes(name)) {
      return name;
    }
  }
  
  // Then try case-insensitive match
  for (const name of possibleNames) {
    const match = availableProperties.find(prop => 
      prop.toLowerCase() === name.toLowerCase()
    );
    if (match) {
      return match;
    }
  }
  
  // Then try partial match (contains)
  for (const name of possibleNames) {
    const match = availableProperties.find(prop => 
      prop.toLowerCase().includes(name.toLowerCase()) || 
      name.toLowerCase().includes(prop.toLowerCase())
    );
    if (match) {
      return match;
    }
  }
  
  // Default to the first possible name if no match found
  return possibleNames[0];
}

// Helper function to get property type
function getPropertyType(propertyInfoMap: any, propertyName: string): string | null {
  if (!propertyInfoMap[propertyName]) {
    return null;
  }
  return propertyInfoMap[propertyName].type;
}

// Helper function to create a rich text property
function createRichTextProperty(text: string) {
  return {
    rich_text: [
      {
        text: {
          content: text.substring(0, 2000) // Notion has a 2000 char limit
        }
      }
    ]
  };
}

// Helper function to create a date property
function createDateProperty(dateStr: string) {
  try {
    // Try to parse the date
    const date = new Date(dateStr);
    if (isNaN(date.getTime())) {
      return { date: null };
    }
    return {
      date: {
        start: date.toISOString().split('T')[0]
      }
    };
  } catch (error) {
    return { date: null };
  }
}

// Helper function to create a select property
function createSelectProperty(name: string) {
  return {
    select: {
      name: name.substring(0, 100) // Notion has a limit on select values
    }
  };
}

// Helper function to create a multi-select property
function createMultiSelectProperty(names: string[]) {
  return {
    multi_select: names.map(name => ({
      name: name.substring(0, 100) // Notion has a limit on select values
    }))
  };
}

// Helper function to create a title property
function createTitleProperty(text: string) {
  return {
    title: [
      {
        text: {
          content: text
        }
      }
    ]
  };
}

// Helper function to parse multiple authors
function parseAuthors(authorText: string): string[] {
  if (!authorText) return [];
  
  // Split by common separators
  const authors = authorText
    .split(/,|\band\b|&|;/)
    .map(author => author.trim())
    .filter(author => author.length > 0);
  
  return authors.length > 0 ? authors : [authorText];
}

// Helper function to create content blocks
function createContentBlocks(content: string) {
  // Split content into paragraphs
  const paragraphs = content
    .split(/\n\n|\r\n\r\n/)
    .map(p => p.trim())
    .filter(p => p.length > 0);
  
  // Create blocks for each paragraph (limit to ~15 paragraphs to avoid huge pages)
  return paragraphs.slice(0, 15).map(paragraph => ({
    object: "block" as const,
    type: "paragraph" as const,
    paragraph: {
      rich_text: [{ 
        type: "text" as const, 
        text: { content: paragraph } 
      }]
    }
  }));
}

// Helper function to create a simple summary (first sentence or first 150 chars)
function createSimpleSummary(content: string): string {
  if (!content) return '';
  
  // Try to get the first sentence
  const match = content.match(/^[^.!?]*[.!?]/);
  if (match && match[0]) {
    return match[0].trim();
  }
  
  // Fallback to first X characters
  return content.substring(0, 150).trim() + (content.length > 150 ? '...' : '');
}

// Helper function to extract metadata from a URL
async function extractMetadataFromUrl(url: string) {
  // Fetch the webpage
  const response = await axios.get(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml',
      'Accept-Language': 'en-US,en;q=0.9'
    },
    timeout: 10000,
    maxRedirects: 5
  });
  
  // Parse HTML
  const $ = cheerio.load(response.data);
  
  // Extract metadata
  const publication = extractPublication($, url);
  const author = extractAuthor($);
  const date = extractDate($);
  const content = extractContent($);
  
  return { publication, author, date, content };
}

// Helper function to extract author
function extractAuthor($: cheerio.CheerioAPI): string {
  // Initialize with empty string, not a default value
  let author = '';
  
  // Log extraction attempts for debugging
  const attempts: string[] = [];
  
  // 1. Look for explicit author rel attribute (highest confidence)
  const relAuthor = $('[rel="author"]').first();
  if (relAuthor.length) {
    author = relAuthor.text().trim();
    attempts.push(`rel="author": "${author}"`);
    if (author) return author;
  }
  
  // 2. Look for byline classes (high confidence)
  const bylineSelectors = [
    '.byline', '.author', '.article-byline', '.c-byline__author',
    '.post-author', '.writer', '.c-author', '.bh__byline_wrapper',
    '.article__byline', '[itemprop="author"]', '.author-name',
    '.ArticleHeader-byline', '.story-meta__authors', '.article-meta__author'
  ];
  
  for (const selector of bylineSelectors) {
    const bylineElement = $(selector).first();
    if (bylineElement.length) {
      // First check if there's a name subclass
      const nameElement = bylineElement.find('.name, .author-name').first();
      
      // Use the name subclass if available, otherwise use the byline element itself
      const text = nameElement.length 
        ? nameElement.text().trim() 
        : bylineElement.text().trim();
      
      // Cleanup: Remove "By", "By:", "Author:", etc.
      let cleanText = text.replace(/^(By|Author|Written by|Posted by)(\s*:)?\s+/i, '');
      
      // Remove "• date" or "• time ago" patterns that sometimes appear with bylines
      cleanText = cleanText.replace(/\s+[•·]\s+.*$/, '');
      
      attempts.push(`${selector}: "${cleanText}"`);
      
      if (cleanText && cleanText.length < 100) {
        author = cleanText;
        // Don't return immediately, continue checking other selectors for highest confidence
        if (cleanText.match(/^[A-Z][a-z]+(\s+[A-Z][a-z]+)+$/)) {
          // If it looks like a proper name (e.g., "John Smith"), return it
          return author;
        }
      }
    }
  }
  
  // 3. Check common meta tags (medium confidence)
  const metaAuthor = $('meta[name="author"]').attr('content') || 
                    $('meta[property="article:author"]').attr('content') ||
                    $('meta[property="og:article:author"]').attr('content');
  
  if (metaAuthor) {
    attempts.push(`meta tag: "${metaAuthor}"`);
    // If we haven't found an author yet or the meta tag looks better
    if (!author || (metaAuthor.length < author.length && metaAuthor.includes(' '))) {
      author = metaAuthor;
    }
  }
  
  // 4. Look for JSON-LD structured data (medium-high confidence)
  const jsonLdScripts = $('script[type="application/ld+json"]');
  if (jsonLdScripts.length) {
    jsonLdScripts.each((i, el) => {
      try {
        const jsonLd = JSON.parse($(el).html() || '');
        // Handle various JSON-LD formats
        const possibleAuthor = extractAuthorFromJsonLd(jsonLd);
        if (possibleAuthor) {
          attempts.push(`JSON-LD: "${possibleAuthor}"`);
          // If we haven't found an author yet or the JSON-LD one looks better
          if (!author || (possibleAuthor.length < author.length && possibleAuthor.includes(' '))) {
            author = possibleAuthor;
          }
        }
      } catch (e) {
        // Ignore JSON parsing errors
      }
    });
  }
  
  return author;
}

// Helper function to extract author from JSON-LD
function extractAuthorFromJsonLd(jsonLd: any): string {
  // Handle array of JSON-LD objects
  if (Array.isArray(jsonLd)) {
    for (const item of jsonLd) {
      const author = extractAuthorFromJsonLd(item);
      if (author) return author;
    }
    return '';
  }
  
  // Check for author in different formats
  if (typeof jsonLd?.author === 'string') {
    return jsonLd.author;
  }
  
  if (jsonLd?.author?.name) {
    return jsonLd.author.name;
  }
  
  // Handle array of authors
  if (Array.isArray(jsonLd?.author) && jsonLd.author.length > 0) {
    if (typeof jsonLd.author[0] === 'string') {
      return jsonLd.author[0];
    }
    if (jsonLd.author[0]?.name) {
      return jsonLd.author[0].name;
    }
  }
  
  // Check for creator
  if (typeof jsonLd?.creator === 'string') {
    return jsonLd.creator;
  }
  
  if (jsonLd?.creator?.name) {
    return jsonLd.creator.name;
  }
  
  return '';
}

// Helper function to extract date
function extractDate($: cheerio.CheerioAPI): string {
  // Initialize with empty string instead of a default value
  let dateStr = '';
  
  // Log extraction attempts for debugging
  const attempts: string[] = [];
  
  // 1. Look for structured data in JSON-LD (highest confidence)
  const jsonLdScripts = $('script[type="application/ld+json"]');
  if (jsonLdScripts.length) {
    jsonLdScripts.each((i, el) => {
      try {
        const jsonLd = JSON.parse($(el).html() || '');
        const possibleDate = extractDateFromJsonLd(jsonLd);
        if (possibleDate) {
          attempts.push(`JSON-LD date: "${possibleDate}"`);
          if (isValidDate(possibleDate)) {
            dateStr = possibleDate;
            // High confidence, can return early
            return false; // Break the each loop
          }
        }
      } catch (e) {
        // Ignore JSON parsing errors
      }
    });
    
    if (dateStr) return dateStr;
  }
  
  // 2. Look for meta tags (high confidence)
  const metaDateSelectors = [
    'meta[property="article:published_time"]',
    'meta[name="date"]',
    'meta[name="DC.date.issued"]',
    'meta[name="publication_date"]',
    'meta[name="publish-date"]',
    'meta[property="og:published_time"]',
    'meta[itemprop="datePublished"]'
  ];
  
  for (const selector of metaDateSelectors) {
    const metaDate = $(selector).attr('content');
    if (metaDate) {
      attempts.push(`${selector}: "${metaDate}"`);
      if (isValidDate(metaDate)) {
        return metaDate;
      }
    }
  }
  
  // 3. Look for time elements (medium-high confidence)
  const timeElements = $('time');
  if (timeElements.length) {
    // First check for datetime attribute
    const timeWithDatetime = timeElements.filter((i, el) => $(el).attr('datetime') !== undefined).first();
    if (timeWithDatetime.length) {
      const datetime = timeWithDatetime.attr('datetime');
      if (datetime) {
        attempts.push(`time[datetime]: "${datetime}"`);
        if (isValidDate(datetime)) {
          return datetime;
        }
      }
    }
    
    // Then check for time element content
    const firstTime = timeElements.first();
    if (firstTime.length) {
      const timeText = firstTime.text().trim();
      attempts.push(`time element: "${timeText}"`);
      if (timeText && timeText.length < 50) {
        dateStr = timeText;
      }
    }
  }
  
  // 4. Look for date patterns in common elements
  const dateSelectors = [
    '.date', '.published', '.post-date', '.article-date',
    '.publish-date', '.timestamp', '.article__date', '.c-timestamp',
    '.post__date', '.article-time', '.ArticleHeader-date',
    '.article-meta__date', '[itemprop="datePublished"]'
  ];
  
  for (const selector of dateSelectors) {
    const dateElement = $(selector).first();
    if (dateElement.length) {
      const text = dateElement.text().trim();
      attempts.push(`${selector}: "${text}"`);
      if (text && text.length < 50) {
        // Try to parse it
        const parsedDate = parseLooseDate(text);
        if (parsedDate) {
          return parsedDate;
        }
        
        // Otherwise just use the text
        if (!dateStr) {
          dateStr = text;
        }
      }
    }
  }
  
  return dateStr;
}

// Helper function to extract date from JSON-LD
function extractDateFromJsonLd(jsonLd: any): string {
  // Handle array of JSON-LD objects
  if (Array.isArray(jsonLd)) {
    for (const item of jsonLd) {
      const date = extractDateFromJsonLd(item);
      if (date) return date;
    }
    return '';
  }
  
  // Check different date fields in order of preference
  const dateFields = [
    'datePublished', 
    'dateCreated', 
    'dateModified',
    'publishedDate',
    'datePosted'
  ];
  
  for (const field of dateFields) {
    if (jsonLd?.[field]) {
      return jsonLd[field];
    }
  }
  
  return '';
}

// Helper function to validate a date string
function isValidDate(dateStr: string): boolean {
  try {
    const date = new Date(dateStr);
    // Check if it's a valid date and within a reasonable range (1995 to present)
    return !isNaN(date.getTime()) && 
           date.getFullYear() >= 1995 && 
           date.getFullYear() <= new Date().getFullYear();
  } catch (e) {
    return false;
  }
}

// Helper function to parse dates in various formats
function parseLooseDate(text: string): string | null {
  // First try direct parsing
  if (isValidDate(text)) {
    return text;
  }
  
  // Try to extract a date using common patterns
  const monthNames = ['january', 'february', 'march', 'april', 'may', 'june', 
                       'july', 'august', 'september', 'october', 'november', 'december'];
  const shortMonthNames = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 
                           'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
  
  // Pattern: Month DD, YYYY (e.g., "January 1, 2020" or "Jan 1, 2020")
  const pattern1 = new RegExp(
    `(${monthNames.join('|')}|${shortMonthNames.join('|')})\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?,\\s+(\\d{4})`,
    'i'
  );
  
  // Pattern: DD Month YYYY (e.g., "1 January 2020" or "1 Jan 2020")
  const pattern2 = new RegExp(
    `(\\d{1,2})(?:st|nd|rd|th)?\\s+(${monthNames.join('|')}|${shortMonthNames.join('|')})\\.?\\s+(\\d{4})`,
    'i'
  );
  
  // Pattern: YYYY-MM-DD or MM/DD/YYYY or DD/MM/YYYY
  const pattern3 = /(\d{4})[-\/](\d{1,2})[-\/](\d{1,2})|(\d{1,2})[-\/](\d{1,2})[-\/](\d{4})/;
  
  let match;
  
  // Try pattern 1: Month DD, YYYY
  match = text.match(pattern1);
  if (match) {
    const month = match[1].toLowerCase();
    let monthNum;
    if (month.length <= 3) {
      monthNum = shortMonthNames.findIndex(m => m === month) + 1;
    } else {
      monthNum = monthNames.findIndex(m => m === month) + 1;
    }
    if (monthNum === 0) monthNum = 1; // Default to January if not found
    
    const day = parseInt(match[2], 10);
    const year = parseInt(match[3], 10);
    
    return `${year}-${monthNum.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  }
  
  // Try pattern 2: DD Month YYYY
  match = text.match(pattern2);
  if (match) {
    const day = parseInt(match[1], 10);
    const month = match[2].toLowerCase();
    const year = parseInt(match[3], 10);
    
    let monthNum;
    if (month.length <= 3) {
      monthNum = shortMonthNames.findIndex(m => m === month) + 1;
    } else {
      monthNum = monthNames.findIndex(m => m === month) + 1;
    }
    if (monthNum === 0) monthNum = 1; // Default to January if not found
    
    return `${year}-${monthNum.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
  }
  
  // Try pattern 3: YYYY-MM-DD or MM/DD/YYYY or DD/MM/YYYY
  match = text.match(pattern3);
  if (match) {
    if (match[1]) {
      // YYYY-MM-DD
      const year = parseInt(match[1], 10);
      const month = parseInt(match[2], 10);
      const day = parseInt(match[3], 10);
      return `${year}-${month.toString().padStart(2, '0')}-${day.toString().padStart(2, '0')}`;
    } else {
      // MM/DD/YYYY or DD/MM/YYYY
      const year = parseInt(match[6], 10);
      const part1 = parseInt(match[4], 10);
      const part2 = parseInt(match[5], 10);
      
      // Heuristic: if part1 > 12, it's likely DD/MM/YYYY, otherwise assume MM/DD/YYYY
      if (part1 > 12) {
        return `${year}-${part2.toString().padStart(2, '0')}-${part1.toString().padStart(2, '0')}`;
      } else {
        return `${year}-${part1.toString().padStart(2, '0')}-${part2.toString().padStart(2, '0')}`;
      }
    }
  }
  
  return null;
}

// Helper function to extract publication name
function extractPublication($: cheerio.CheerioAPI, url: string): string {
  // Log extraction attempts for debugging
  const attempts: string[] = [];
  
  // Try Open Graph site_name (highest confidence)
  const ogSiteName = $('meta[property="og:site_name"]').attr('content');
  if (ogSiteName) {
    attempts.push(`og:site_name: "${ogSiteName}"`);
    return ogSiteName;
  }
  
  // Try JSON-LD for publisher name (high confidence)
  const jsonLdScripts = $('script[type="application/ld+json"]');
  if (jsonLdScripts.length) {
    let publisher = '';
    jsonLdScripts.each((i, el) => {
      try {
        const jsonLd = JSON.parse($(el).html() || '');
        const possiblePublisher = extractPublisherFromJsonLd(jsonLd);
        if (possiblePublisher) {
          attempts.push(`JSON-LD publisher: "${possiblePublisher}"`);
          publisher = possiblePublisher;
          return false; // Break the each loop
        }
      } catch (e) {
        // Ignore JSON parsing errors
      }
    });
    
    if (publisher) return publisher;
  }
  
  // Try other common meta tags (medium confidence)
  const publisherMeta = $('meta[name="publisher"]').attr('content') ||
                        $('meta[name="application-name"]').attr('content') ||
                        $('meta[property="og:site"]').attr('content');
  
  if (publisherMeta) {
    attempts.push(`meta publisher: "${publisherMeta}"`);
    return publisherMeta;
  }
  
  // Try to find publication name in the site header (medium confidence)
  const headerSelectors = [
    'header .logo', 'header .site-title', 'header .brand', 
    '.site-title', '.logo img', '.logo', '.brand', 
    '#logo', '[itemprop="publisher"]'
  ];
  
  for (const selector of headerSelectors) {
    const headerElement = $(selector).first();
    if (headerElement.length) {
      // Check for alt text in image
      if (headerElement.is('img')) {
        const alt = headerElement.attr('alt');
        if (alt && alt.length < 50) {
          attempts.push(`${selector} alt: "${alt}"`);
          return alt;
        }
      }
      
      // Otherwise use text content
      const text = headerElement.text().trim();
      if (text && text.length < 50) {
        attempts.push(`${selector} text: "${text}"`);
        return text;
      }
    }
  }
  
  // Extract from domain as fallback (low confidence)
  try {
    const domain = new URL(url).hostname.replace(/^www\./, '');
    attempts.push(`domain: "${domain}"`);
    
    // Extract the name part of the domain
    const parts = domain.split('.');
    if (parts.length > 0) {
      const name = parts[0]
        .replace(/-/g, ' ')
        .split(' ')
        .map(word => word.charAt(0).toUpperCase() + word.slice(1))
        .join(' ');
      
      attempts.push(`formatted domain: "${name}"`);
      return name;
    }
    return domain;
  } catch (e) {
    return 'Unknown Publication';
  }
}

// Helper function to extract publisher from JSON-LD
function extractPublisherFromJsonLd(jsonLd: any): string {
  // Handle array of JSON-LD objects
  if (Array.isArray(jsonLd)) {
    for (const item of jsonLd) {
      const publisher = extractPublisherFromJsonLd(item);
      if (publisher) return publisher;
    }
    return '';
  }
  
  // Check for publisher in different formats
  if (jsonLd?.publisher?.name) {
    return jsonLd.publisher.name;
  }
  
  if (typeof jsonLd?.publisher === 'string') {
    return jsonLd.publisher;
  }
  
  if (jsonLd?.provider?.name) {
    return jsonLd.provider.name;
  }
  
  if (jsonLd?.sourceOrganization?.name) {
    return jsonLd.sourceOrganization.name;
  }
  
  return '';
}

// Helper function to extract content
function extractContent($: cheerio.CheerioAPI): string {
  // Try to get the article content
  const contentSelectors = [
    'article', '.article-content', '.post-content', '.entry-content',
    '.article-body', '.story-body', '.story-content', '.content-body',
    '.post-body', '#article-body', '.article__body', '.c-entry-content'
  ];
  
  let content = '';
  
  // First try meta description for a summary
  const metaDescription = $('meta[name="description"]').attr('content') || 
                          $('meta[property="og:description"]').attr('content');
  if (metaDescription) {
    content = metaDescription;
  }
  
  // Then try to extract the main article content
  if (!content || content.length < 100) {
    for (const selector of contentSelectors) {
      const contentElement = $(selector).first();
      if (contentElement.length) {
        // Get text from paragraphs
        const paragraphs = contentElement.find('p');
        if (paragraphs.length) {
          content = '';
          paragraphs.each((i, el) => {
            if (i < 10) { // Limit to first 10 paragraphs
              const paragraphText = $(el).text().trim();
              if (paragraphText) {
                content += paragraphText + ' ';
              }
            }
          });
          break;
        } else {
          // If no paragraphs, just get the text
          content = contentElement.text().trim();
          break;
        }
      }
    }
  }
  
  return content;
}

// Start the server without console.log statements that break the protocol
const start = async () => {
  try {
    // Test Notion API connection
    try {
      await notion.users.me({});
    } catch (error) {
      process.stderr.write("Failed to connect to Notion API. Check your API key.\n");
      process.exit(1);
    }
    
    const transport = new StdioServerTransport();
    await server.connect(transport);
  } catch (error) {
    process.stderr.write(`Server error: ${error}\n`);
    process.exit(1);
  }
};

start(); 