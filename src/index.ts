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
    generateSummary: z.boolean().default(true),
    silentErrors: z.boolean().default(true)
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
    generateSummary,
    silentErrors
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
              try {
                if (publicationPropertyType === 'select') {
                  properties[publicationProperty] = createSelectProperty(metadata.publication);
                } else if (publicationPropertyType === 'rich_text') {
                  properties[publicationProperty] = createRichTextProperty(metadata.publication);
                } else if (publicationPropertyType === 'title') {
                  properties[publicationProperty] = createTitleProperty(metadata.publication);
                }
              } catch (err: any) {
                if (!silentErrors) {
                  return `Row ${page.id}: Error setting ${publicationProperty} property: ${err.message}`;
                }
              }
            }
            
            // Handle author based on property type
            if (metadata.author && authorPropertyType) {
              try {
                if (authorPropertyType === 'multi_select') {
                  properties[authorProperty] = createMultiSelectProperty(parseAuthors(metadata.author));
                } else if (authorPropertyType === 'select') {
                  properties[authorProperty] = createSelectProperty(metadata.author);
                } else if (authorPropertyType === 'rich_text') {
                  properties[authorProperty] = createRichTextProperty(metadata.author);
                }
              } catch (err: any) {
                if (!silentErrors) {
                  return `Row ${page.id}: Error setting ${authorProperty} property: ${err.message}`;
                }
              }
            }
            
            // Handle date based on property type
            if (metadata.date && datePropertyType === 'date') {
              try {
                properties[dateProperty] = createDateProperty(metadata.date);
              } catch (err: any) {
                if (!silentErrors) {
                  return `Row ${page.id}: Error setting ${dateProperty} property: ${err.message}`;
                }
              }
            }
            
            // Get content for page update and summary generation
            let content = metadata.content || '';
            let summary = '';
            
            // Generate summary using extracted content
            if (content && generateSummary && summaryPropertyType) {
              try {
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
              } catch (err: any) {
                if (!silentErrors) {
                  return `Row ${page.id}: Error setting ${summaryProperty} property: ${err.message}`;
                }
              }
            }
            
            // Update the page properties if we have any to update
            if (Object.keys(properties).length > 0) {
              try {
                await notion.pages.update({
                  page_id: page.id,
                  properties: properties
                });
              } catch (err: any) {
                if (!silentErrors) {
                  return `Row ${page.id}: Error updating properties: ${err.message}`;
                }
                // If we fail to update properties, we'll still try to update content
              }
            }
            
            // Update the page content if we have content and it's not already in the page
            if (content) {
              try {
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
              } catch (err: any) {
                if (!silentErrors) {
                  return `Row ${page.id}: Error updating content: ${err.message}`;
                }
              }
            }
            
            successCount++;
            return `Row ${page.id}: Successfully extracted metadata from ${url}`;
          } catch (error: any) {
            failureCount++;
            return `Row ${page.id}: Failed to extract metadata - ${silentErrors ? 'Error occurred' : error.message}`;
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

// Tool: Add an article to a database
server.tool(
  "add-article",
  { 
    url: z.string().url(),
    databaseId: z.string(),
    generateSummary: z.boolean().default(true)
  },
  async ({ url, databaseId, generateSummary }) => {
    try {
      // First retrieve database to get property types
      const databaseInfo = await notion.databases.retrieve({
        database_id: databaseId
      });
      
      // Get all available property types
      const propertyInfoMap = databaseInfo.properties || {};
      
      // Auto-detect property names
      const urlPropertyName = findMatchingProperty(propertyInfoMap, [
        "URL", "Link", "Website", "Address", "Source Link"
      ]);
      
      const titlePropertyName = findMatchingProperty(propertyInfoMap, [
        "Title", "Name", "Article Title", "Headline", "Topic"
      ]);
      
      const publicationPropertyName = findMatchingProperty(propertyInfoMap, [
        "Publication", "Publisher", "Source", "Site", "Website Name", "Origin"
      ]);
      
      const authorPropertyName = findMatchingProperty(propertyInfoMap, [
        "Author", "Author(s)", "Writer", "Creator", "By"
      ]);
      
      const datePropertyName = findMatchingProperty(propertyInfoMap, [
        "Date", "Published", "Published Date", "Publish Date", "Release Date", "Post Date"
      ]);
      
      const summaryPropertyName = findMatchingProperty(propertyInfoMap, [
        "Summary", "Article Summary", "TLDR", "Description", "Brief"
      ]);
      
      // Get property types for the detected properties
      const titlePropertyType = getPropertyType(propertyInfoMap, titlePropertyName);
      const publicationPropertyType = getPropertyType(propertyInfoMap, publicationPropertyName);
      const authorPropertyType = getPropertyType(propertyInfoMap, authorPropertyName);
      const datePropertyType = getPropertyType(propertyInfoMap, datePropertyName);
      const summaryPropertyType = getPropertyType(propertyInfoMap, summaryPropertyName);
      const urlPropertyType = getPropertyType(propertyInfoMap, urlPropertyName);
      
      // Log the detected fields
      console.log(`Using field mapping:
- Title: "${titlePropertyName}" (${titlePropertyType})
- URL: "${urlPropertyName}" (${urlPropertyType})
- Publication: "${publicationPropertyName}" (${publicationPropertyType})
- Author: "${authorPropertyName}" (${authorPropertyType})
- Date: "${datePropertyName}" (${datePropertyType})
- Summary: "${summaryPropertyName}" (${summaryPropertyType})`);
      
      // Extract metadata from the URL
      const metadata = await extractMetadataFromUrl(url);
      const { publication, author, date, content } = metadata;
      
      // Use the URL's title or domain as the article title if not extracted
      let title = "";
      
      // Try to extract title from HTML
      try {
        const response = await axios.get(url, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/91.0.4472.124 Safari/537.36',
          },
          timeout: 10000,
          maxRedirects: 5
        });
        
        const $ = cheerio.load(response.data);
        title = $('title').text().trim() || 
                $('meta[property="og:title"]').attr('content') || 
                $('meta[name="twitter:title"]').attr('content') || 
                new URL(url).hostname;
      } catch (error) {
        // If we can't access the URL, use the domain as title
        try {
          title = new URL(url).hostname;
        } catch (e) {
          title = url;
        }
      }
      
      // Generate summary if needed
      let summary = "";
      if (generateSummary && content) {
        // For now, use a simple summarization method
        summary = createSimpleSummary(content);
      }
      
      // Create the page properties
      const properties: any = {};
      
      // Set the title property
      if (titlePropertyName && titlePropertyType) {
        if (titlePropertyType === 'title') {
          properties[titlePropertyName] = createTitleProperty(title);
        } else if (titlePropertyType === 'rich_text') {
          properties[titlePropertyName] = createRichTextProperty(title);
        }
      }
      
      // Set the URL property
      if (urlPropertyName && urlPropertyType) {
        if (urlPropertyType === 'url') {
          properties[urlPropertyName] = { url };
        } else if (urlPropertyType === 'rich_text') {
          properties[urlPropertyName] = createRichTextProperty(url);
        }
      }
      
      // Set the publication property
      if (publicationPropertyName && publicationPropertyType && publication) {
        if (publicationPropertyType === 'select') {
          properties[publicationPropertyName] = createSelectProperty(publication);
        } else if (publicationPropertyType === 'rich_text') {
          properties[publicationPropertyName] = createRichTextProperty(publication);
        } else if (publicationPropertyType === 'title') {
          properties[publicationPropertyName] = createTitleProperty(publication);
        }
      }
      
      // Set the author property
      if (authorPropertyName && authorPropertyType && author) {
        if (authorPropertyType === 'multi_select') {
          properties[authorPropertyName] = createMultiSelectProperty(parseAuthors(author));
        } else if (authorPropertyType === 'select') {
          properties[authorPropertyName] = createSelectProperty(author);
        } else if (authorPropertyType === 'rich_text') {
          properties[authorPropertyName] = createRichTextProperty(author);
        }
      }
      
      // Set the date property
      if (datePropertyName && datePropertyType === 'date' && date) {
        properties[datePropertyName] = createDateProperty(date);
      }
      
      // Set the summary property
      if (summaryPropertyName && summaryPropertyType && summary) {
        if (summaryPropertyType === 'rich_text') {
          properties[summaryPropertyName] = createRichTextProperty(summary);
        } else if (summaryPropertyType === 'select') {
          properties[summaryPropertyName] = createSelectProperty(summary);
        } else if (summaryPropertyType === 'multi_select') {
          properties[summaryPropertyName] = createMultiSelectProperty([summary]);
        }
      }
      
      // Create the page in Notion
      const response = await notion.pages.create({
        parent: {
          database_id: databaseId
        },
        properties: properties
      });
      
      // Add content blocks if we have content
      if (content && response.id) {
        try {
          // Create content blocks (paragraphs)
          const contentBlocks = createContentBlocks(content);
          
          await notion.blocks.children.append({
            block_id: response.id,
            children: contentBlocks
          });
        } catch (err: any) {
          console.error(`Error updating content: ${err.message}`);
        }
      }
      
      // Return success with extracted fields
      return {
        content: [{
          type: "text",
          text: `✅ Article added to your database!\n\n` +
                `🔗 URL: ${url}\n` +
                `📝 Title: ${title}\n` +
                (publication ? `📰 Publication: ${publication}\n` : '') +
                (author ? `✍️ Author: ${author}\n` : '') +
                (date ? `📅 Date: ${date}\n` : '') +
                (summary ? `\n📌 Summary: ${summary}` : '')
        }]
      };
    } catch (error: any) {
      return {
        content: [{
          type: "text",
          text: `Error adding article: ${error.message}`
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

// Helper function to find the main content area of an article
function findMainContentArea($: cheerio.CheerioAPI): any {
  // Common selectors for main content areas in articles
  const contentSelectors = [
    'article', 
    '[itemprop="articleBody"]',
    '.article-content',
    '.post-content',
    '.entry-content',
    '.story-body',
    '#article-body',
    '.content-body',
    'main',
    '.main-content'
  ];
  
  for (const selector of contentSelectors) {
    const element = $(selector).first();
    if (element.length) {
      return element[0];
    }
  }
  
  // If no main content area is found, return null
  return null;
}

// Helper function to sanitize JSON strings before parsing
function sanitizeJsonString(jsonString: string): string | null {
  try {
    // Remove potential HTML comments
    let cleaned = jsonString.replace(/<!--[\s\S]*?-->/g, '');
    
    // Remove trailing commas in objects and arrays
    cleaned = cleaned.replace(/,\s*([\]}])/g, '$1');
    
    // Fix unquoted property names
    cleaned = cleaned.replace(/([{,]\s*)([a-zA-Z0-9_$]+)\s*:/g, '$1"$2":');
    
    // Handle single quotes instead of double quotes for strings
    // This is a simplistic approach and may not handle all cases correctly
    let inString = false;
    let inSingleQuoteString = false;
    let result = '';
    
    for (let i = 0; i < cleaned.length; i++) {
      const char = cleaned[i];
      const prevChar = i > 0 ? cleaned[i - 1] : '';
      
      if (char === '"' && prevChar !== '\\') {
        inString = !inString;
        result += char;
      } else if (char === "'" && prevChar !== '\\' && !inString) {
        inSingleQuoteString = !inSingleQuoteString;
        result += '"'; // Replace single quote with double quote
      } else if (inSingleQuoteString && char === "'" && prevChar === '\\') {
        // Handle escaped single quote inside a single-quoted string
        result = result.slice(0, -1) + "\\'"; // Keep the escape and single quote
      } else {
        result += char;
      }
    }
    
    // Quick validation check - does it at least start with { or [ and end with } or ]?
    const trimmed = result.trim();
    if (
      (trimmed.startsWith('{') && trimmed.endsWith('}')) || 
      (trimmed.startsWith('[') && trimmed.endsWith(']'))
    ) {
      return trimmed;
    }
    
    return null; // Signal that we couldn't clean it properly
  } catch (e) {
    return null; // Return null if any error occurs during cleaning
  }
}

// Helper function to extract author
function extractAuthor($: cheerio.CheerioAPI): string {
  // Initialize with empty string instead of a default value
  let authorStr = '';
  
  // Log extraction attempts for debugging
  const attempts: string[] = [];
  
  // Get the raw HTML once for validation later
  const rawHtml = $.html().toLowerCase();
  
  // Check for site-specific extractors first
  const hostname = getHostnameFromHtml($);
  if (hostname) {
    // AP News specific extraction
    if (hostname.includes('apnews.com')) {
      attempts.push(`Using AP News-specific extractor`);
      const authors = $('.Page-authors');
      if (authors.length) {
        // Find all author links within the container
        const authorLinks = authors.find('a');
        if (authorLinks.length) {
          const authorNames: string[] = [];
          authorLinks.each((i, el) => {
            const name = $(el).text().trim();
            if (name) authorNames.push(name);
          });
          if (authorNames.length) {
            authorStr = authorNames.join(', ');
            attempts.push(`AP News byline found: ${authorStr}`);
            return authorStr;
          }
        }
      }
    }
    
    // New York Times specific extraction
    if (hostname.includes('nytimes.com')) {
      attempts.push(`Using NYT-specific extractor`);
      // NYT typically has bylines with specific structure
      const nytByline = $('.byline-author, .last-byline, .css-1baulvz');
      if (nytByline.length) {
        authorStr = nytByline.first().text().trim();
        attempts.push(`NYT byline found: ${authorStr}`);
      }
      
      // Check for author in meta tags (NYT usually has this)
      if (!authorStr) {
        const metaAuthor = $('meta[name="byl"]').attr('content');
        if (metaAuthor) {
          authorStr = metaAuthor.replace(/^by\s+/i, '').trim();
          attempts.push(`NYT meta byl tag: ${authorStr}`);
        }
      }
      
      // If found through site-specific extractor and passes validation, return early
      if (authorStr && validateExtractedAuthor(authorStr, rawHtml)) {
        return authorStr;
      }
    }
  }
  
  // Look for common author container patterns first
  // This handles multiple authors in various structures
  const authorContainerSelectors = [
    '.author-container', '.byline-container', '.article-authors', 
    '.byline-wrapper', '.authors-container', '.authors-list',
    '.author-byline', '.meta-authors', '.page-authors',
    '.article__byline', '.c-byline', '.article-byline',
    '[data-testid="byline"]', '[data-component="byline"]',
    '.story-meta-authors', '.story-header__authors'
  ];
  
  for (const containerSelector of authorContainerSelectors) {
    const container = $(containerSelector);
    if (container.length) {
      attempts.push(`Found author container: ${containerSelector}`);
      
      // Check for author links within the container
      const authorLinks = container.find('a[href*="author"], a[rel="author"], a.author-link, a.writer-link');
      if (authorLinks.length) {
        const authorNames: string[] = [];
        authorLinks.each((i, el) => {
          const name = $(el).text().trim();
          if (name && name.length > 2) authorNames.push(name);
        });
        
        if (authorNames.length) {
          authorStr = authorNames.join(', ');
          attempts.push(`Found multiple authors in links: ${authorStr}`);
          
          if (validateExtractedAuthor(authorStr, rawHtml)) {
            return authorStr;
          }
        }
      }
      
      // If no links found or validation failed, try container text
      const containerText = container.text().trim()
        .replace(/^by\s+|^byline:\s+|^author[s]?:\s+/i, '')
        .replace(/\s+and\s+/g, ', ')
        .replace(/\s*,\s*/g, ', ')
        .trim();
      
      if (containerText && validateExtractedAuthor(containerText, rawHtml)) {
        authorStr = containerText;
        attempts.push(`Found authors from container text: ${authorStr}`);
        return authorStr;
      }
    }
  }
  
  // 1. Look for structured data in JSON-LD (highest confidence)
  const jsonLdScripts = $('script[type="application/ld+json"]');
  if (jsonLdScripts.length) {
    jsonLdScripts.each((i, el) => {
      try {
        // Safely parse the JSON, with error handling
        const scriptContent = $(el).html() || '';
        const cleanedJson = sanitizeJsonString(scriptContent);
        
        if (!cleanedJson) return; // Skip if we couldn't clean it
        
        const jsonLd = JSON.parse(cleanedJson);
        const author = extractAuthorFromJsonLd(jsonLd);
        
        if (author && validateExtractedAuthor(author, rawHtml)) {
          authorStr = author;
          attempts.push(`Found in JSON-LD: ${author}`);
          return false; // Break the loop
        }
      } catch (e) {
        // Silent catch - continue to next script
      }
    });
  }
  
  if (authorStr) return authorStr;
  
  // 2. Look for main content area to limit our search scope
  const mainContent = findMainContentArea($);
  // Proper typing with 'as'
  const $scope = mainContent ? $(mainContent) : $('body');
  
  // 3. Check for explicit multiple author patterns
  const multiAuthorPatterns = [
    // Look for containers with multiple links
    {
      container: '.byline, .author, [itemprop="author"], .meta-authors',
      elements: 'a'
    },
    // Look for specific author list patterns
    {
      container: '.authors-list, .article-authors, .byline-authors, .writer-names',
      elements: 'li, span.author, span.writer, div.author-name'
    }
  ];
  
  for (const pattern of multiAuthorPatterns) {
    const container = $scope.find(pattern.container);
    if (container.length) {
      const elements = container.find(pattern.elements);
      if (elements.length > 1) {
        // We found multiple elements that might be authors
        const authorNames: string[] = [];
        elements.each((i, el) => {
          const text = $(el).text().trim()
            .replace(/^by\s+|^and\s+|^,\s*/i, '')
            .trim();
          if (text && text.length > 2 && !/^(by|and|,)$/i.test(text)) {
            authorNames.push(text);
          }
        });
        
        if (authorNames.length > 0) {
          authorStr = authorNames.join(', ');
          attempts.push(`Found multiple authors: ${authorStr}`);
          
          if (validateExtractedAuthor(authorStr, rawHtml)) {
            return authorStr;
          }
        }
      }
    }
  }
  
  // 4. Check for elements with rel="author" within main content first
  const relAuthor = $scope.find('[rel="author"]');
  if (relAuthor.length > 1) {
    // Multiple authors with rel="author"
    const authorNames: string[] = [];
    relAuthor.each((i, el) => {
      const text = $(el).text().trim();
      if (text) authorNames.push(text);
    });
    
    if (authorNames.length > 0) {
      authorStr = authorNames.join(', ');
      attempts.push(`Found multiple rel="author": ${authorStr}`);
      
      if (validateExtractedAuthor(authorStr, rawHtml)) {
        return authorStr;
      }
    }
  } else if (relAuthor.length === 1) {
    const text = relAuthor.text().trim();
    if (validateExtractedAuthor(text, rawHtml)) {
      authorStr = text;
      attempts.push(`Found rel="author": ${authorStr}`);
    }
  }
  
  if (!authorStr) {
    // 5. Look for common author/byline classes within main content
    const authorSelectors = [
      '.author', '.byline', '.byline-author', '.article-author', 
      '.post-author', '[itemprop="author"]', '.writer', '.contributor',
      '.c-byline__author', '.story-meta__authors', '.author-name',
      '.article__author', '.bio-name', '.writer-name', '.entry-author'
    ];
    
    for (const selector of authorSelectors) {
      const element = $scope.find(selector).first();
      if (element.length) {
        const text = element.text().trim();
        // Ensure this isn't just "by" or too short to be a real name
        if (text && text.length > 3 && !/^by\s*$/i.test(text)) {
          // Process for multiple authors
          const processedText = text
            .replace(/^by\s+|^byline:\s+|^author[s]?:\s+/i, '')
            .replace(/\s+and\s+/g, ', ')
            .replace(/\s*,\s*/g, ', ')
            .trim();
            
          if (validateExtractedAuthor(processedText, rawHtml)) {
            authorStr = processedText;
            attempts.push(`Found ${selector}: ${processedText}`);
            break;
          }
        }
      }
    }
  }
  
  if (!authorStr) {
    // 6. Look for "by" pattern in text
    const byPattern = /(?:by|writer|author|written by)[:\s]+([A-Z][a-z]+(?:\s+[A-Z][a-z]+)+(?:\s+and\s+[A-Z][a-z]+(?:\s+[A-Z][a-z]+)+)*)/i;
    const articleText = $scope.text();
    const byMatch = articleText.match(byPattern);
    
    if (byMatch && byMatch[1]) {
      const text = byMatch[1].trim()
        .replace(/\s+and\s+/g, ', ');
      
      if (validateExtractedAuthor(text, rawHtml)) {
        authorStr = text;
        attempts.push(`Found by-pattern: ${authorStr}`);
      }
    }
  }
  
  // 7. If we still don't have an author, try with meta tags (lower confidence)
  if (!authorStr) {
    // Try meta tags last (can sometimes have wrong info)
    const metaAuthor = $('meta[name="author"]').attr('content') || 
                      $('meta[property="article:author"]').attr('content') ||
                      $('meta[property="og:author"]').attr('content');
    
    if (metaAuthor && validateExtractedAuthor(metaAuthor, rawHtml)) {
      authorStr = metaAuthor;
      attempts.push(`Found in meta tags: ${metaAuthor}`);
    }
  }
  
  // Clean up the result
  if (authorStr) {
    // Remove "By" prefix if present
    authorStr = authorStr.replace(/^(by|written by|author:)\s+/i, '');
    
    // Remove any excess whitespace
    authorStr = authorStr.replace(/\s+/g, ' ').trim();
  }
  
  // console.log(`Author extraction attempts: ${attempts.join(', ')}`);
  return authorStr;
}

// Helper function to validate that an extracted author actually exists in the HTML
function validateExtractedAuthor(author: string, rawHtml: string): boolean {
  if (!author || author.length < 4) return false;
  
  // Check if this looks like a list of authors
  const isMultipleAuthors = author.includes(',') || author.includes(' and ');
  
  // Clean up the author string for validation
  const cleanAuthor = author
    .replace(/^by\s+/i, '')    // Remove "By" prefix
    .replace(/\s+/g, ' ')      // Normalize spaces
    .trim()
    .toLowerCase();
  
  // Handle multiple authors case
  if (isMultipleAuthors) {
    // Split by commas and " and "
    const authorList = cleanAuthor.split(/,\s*|\s+and\s+/);
    let validAuthorsCount = 0;
    
    for (const singleAuthor of authorList) {
      if (singleAuthor.length < 4) continue; // Skip very short segments
      
      // For each author, check if it appears in the HTML
      if (singleAuthor.includes(' ')) {
        // Author with first and last name
        const nameParts = singleAuthor.split(' ');
        
        // For short first/last names, require both parts to be present
        if (nameParts.length === 2 && 
            nameParts[0].length <= 3 && 
            nameParts[1].length <= 3) {
          const combinedPattern = nameParts.join('\\s+');
          if (new RegExp(combinedPattern, 'i').test(rawHtml)) {
            validAuthorsCount++;
            continue;
          }
        }
        
        // Count how many significant parts are found
        let foundPartsCount = 0;
        for (const part of nameParts) {
          if (part.length >= 4 && rawHtml.includes(part)) {
            foundPartsCount++;
          }
        }
        
        // Consider valid if at least half of significant parts are found
        const significantParts = nameParts.filter(part => part.length >= 4).length;
        if (significantParts > 0 && foundPartsCount >= Math.ceil(significantParts * 0.5)) {
          validAuthorsCount++;
        }
      } else {
        // Single name author (rare but possible)
        if (singleAuthor.length >= 5 && rawHtml.includes(singleAuthor)) {
          validAuthorsCount++;
        }
      }
    }
    
    // Consider the author list valid if at least half the authors were found
    return validAuthorsCount >= Math.ceil(authorList.length * 0.5);
  }
  
  // Single author case - same logic as before
  // Names are usually at least two words
  if (!cleanAuthor.includes(' ')) return false;

  // Check for presence in raw HTML
  // Split the author into parts to handle different formatting
  const nameParts = cleanAuthor.split(' ');
  
  // For short first/last names, require both parts to be present
  if (nameParts.length === 2 && 
      nameParts[0].length <= 3 && 
      nameParts[1].length <= 3) {
    const combinedPattern = nameParts.join('\\s+');
    return new RegExp(combinedPattern, 'i').test(rawHtml);
  }
  
  // For longer names, check if they appear near each other
  let foundCount = 0;
  for (const part of nameParts) {
    // Only validate parts that are at least 4 characters to avoid false positives
    if (part.length >= 4) {
      if (rawHtml.includes(part)) {
        foundCount++;
      }
    }
  }
  
  // Require at least 50% of the significant name parts to be found
  const significantParts = nameParts.filter(part => part.length >= 4).length;
  return significantParts > 0 && foundCount >= Math.ceil(significantParts * 0.5);
}

// Helper function to extract hostname from HTML
function getHostnameFromHtml($: cheerio.CheerioAPI): string {
  // Try to get the hostname from canonical link
  const canonical = $('link[rel="canonical"]').attr('href');
  if (canonical) {
    try {
      return new URL(canonical).hostname;
    } catch (e) {
      // Invalid URL, continue
    }
  }
  
  // Try to get from og:url
  const ogUrl = $('meta[property="og:url"]').attr('content');
  if (ogUrl) {
    try {
      return new URL(ogUrl).hostname;
    } catch (e) {
      // Invalid URL, continue
    }
  }
  
  // No hostname found
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
        // Safely parse the JSON, with error handling
        const scriptContent = $(el).html() || '';
        const cleanedJson = sanitizeJsonString(scriptContent);
        
        if (!cleanedJson) return; // Skip if we couldn't clean it
        
        const jsonLd = JSON.parse(cleanedJson);
        const date = extractDateFromJsonLd(jsonLd);
        
        if (date) {
          dateStr = date;
          attempts.push(`Found in JSON-LD: ${date}`);
          return false; // Break the loop
        }
      } catch (e) {
        // Silent catch - continue to next script
      }
    });
  }
  
  if (dateStr) return dateStr;
  
  // 2. Find the main content area to limit our search scope
  const mainContent = findMainContentArea($);
  // Proper typing with 'as'
  const $scope = mainContent ? $(mainContent) : $('body');
  
  // 3. Look for the author/byline area as dates are often nearby
  const authorArea = $scope.find('.author, .byline, [rel="author"], .meta, .article-meta, .post-meta').first();
  const dateArea = authorArea.length ? authorArea.parent() : $scope;
  
  // 4. Find published dates near the author/byline area first
  const timeSelectors = [
    'time[datetime]', 
    '[itemprop="datePublished"]',
    '.published-date',
    '.publish-date',
    '.post-date',
    '.article-date',
    '.date',
    '.timestamp'
  ];
  
  for (const selector of timeSelectors) {
    const element = dateArea.find(selector).first();
    if (element.length) {
      // Prioritize datetime attribute if available
      const datetime = element.attr('datetime') || element.attr('content');
      if (datetime && isValidDate(datetime)) {
        dateStr = datetime;
        attempts.push(`Found near author ${selector} with datetime: ${dateStr}`);
        break;
      }
      
      // Otherwise use the text content
      const text = element.text().trim();
      if (text && text.length > 5) {
        // Try to parse the text as a date
        const parsedDate = parseLooseDate(text);
        if (parsedDate) {
          dateStr = parsedDate;
          attempts.push(`Found near author ${selector} with text: ${text} -> ${dateStr}`);
          break;
        }
      }
    }
  }
  
  // 5. If no date found near author, look in the whole scope
  if (!dateStr) {
    for (const selector of timeSelectors) {
      const element = $scope.find(selector).first();
      if (element.length) {
        // Prioritize datetime attribute if available
        const datetime = element.attr('datetime') || element.attr('content');
        if (datetime && isValidDate(datetime)) {
          dateStr = datetime;
          attempts.push(`Found in content ${selector} with datetime: ${dateStr}`);
          break;
        }
        
        // Otherwise use the text content
        const text = element.text().trim();
        if (text && text.length > 5) {
          // Ignore if it contains "updated" or "modified"
          if (!/updated|modified/i.test(text)) {
            const parsedDate = parseLooseDate(text);
            if (parsedDate) {
              dateStr = parsedDate;
              attempts.push(`Found in content ${selector} with text: ${text} -> ${dateStr}`);
              break;
            }
          }
        }
      }
    }
  }
  
  // 6. If still no date, check meta tags
  if (!dateStr) {
    // Meta tags in order of reliability
    const metaSelectors = [
      'meta[property="article:published_time"]',
      'meta[itemprop="datePublished"]',
      'meta[name="pubdate"]',
      'meta[name="publishdate"]',
      'meta[name="date"]',
      'meta[property="og:published_time"]'
    ];
    
    for (const selector of metaSelectors) {
      const element = $(selector);
      if (element.length) {
        const content = element.attr('content');
        if (content && isValidDate(content)) {
          dateStr = content;
          attempts.push(`Found in ${selector}: ${content}`);
          break;
        }
      }
    }
  }
  
  // 7. Last resort: search for date patterns in text near the top of the article
  if (!dateStr) {
    // Get the first few paragraphs of text
    const topText = $scope.find('p').slice(0, 3).text();
    const parsedDate = parseLooseDate(topText);
    if (parsedDate) {
      dateStr = parsedDate;
      attempts.push(`Found date pattern in top paragraphs: ${dateStr}`);
    }
  }
  
  // console.log(`Date extraction attempts: ${attempts.join(', ')}`);
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
        // Safely parse the JSON, with error handling
        const scriptContent = $(el).html() || '';
        const cleanedJson = sanitizeJsonString(scriptContent);
        
        if (!cleanedJson) return; // Skip if we couldn't clean it
        
        const jsonLd = JSON.parse(cleanedJson);
        const possiblePublisher = extractPublisherFromJsonLd(jsonLd);
        if (possiblePublisher) {
          attempts.push(`JSON-LD publisher: "${possiblePublisher}"`);
          publisher = possiblePublisher;
          return false; // Break the each loop
        }
      } catch (e) {
        // Silently ignore JSON parsing errors
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