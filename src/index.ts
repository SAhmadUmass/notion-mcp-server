import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Client } from "@notionhq/client";
import { z } from "zod";
import dotenv from "dotenv";
import path from "path";
import fs from "fs";

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