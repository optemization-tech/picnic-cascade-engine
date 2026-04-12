import { NotionClient } from './client.js';
import { config } from '../config.js';

export const cascadeClient = new NotionClient({ tokens: config.notion.tokens });

export const provisionClient = new NotionClient({
  tokens: config.notion.provisionTokens.length > 0
    ? config.notion.provisionTokens
    : config.notion.tokens,
});

export const deletionClient = new NotionClient({
  tokens: config.notion.deletionTokens.length > 0
    ? config.notion.deletionTokens
    : config.notion.tokens,
});
