/**
 * Knowledge store — stubbed until Phase 5.
 *
 * The real thing needs the pgvector extension, an embeddings pipeline and
 * a chunks table, none of which exist yet. Rather than pretend, every
 * tool here refuses honestly through cannot_do, so the gap is logged and
 * visible instead of being answered from the model's memory (which is
 * exactly the "book summary that read no book" failure the rebuild is
 * removing).
 */
import { z } from 'zod';
import { recordRefusal } from './meta';
import type { Tool } from './types';

const NOT_YET = 'Knowledge store abhi ready nahi (Phase 5 mein aayega). Is waqt kitabein/links store nahi kar sakta.';

const knowledgeSearch: Tool<{ query: string }> = {
  name: 'knowledge_search',
  description: 'Kitabon mein jawab dhoondo — abhi band (Phase 5).',
  args: 'query: string',
  schema: z.object({ query: z.string().min(1).max(300) }),
  async run(_args, ctx) {
    return recordRefusal('knowledge_search', NOT_YET, ctx);
  },
};

const knowledgeAddUrl: Tool<{ url: string }> = {
  name: 'knowledge_add_url',
  description: 'Link store mein daalo — abhi band (Phase 5).',
  args: 'url: string',
  schema: z.object({ url: z.string().max(500) }),
  async run(_args, ctx) {
    return recordRefusal('knowledge_add_url', NOT_YET, ctx);
  },
};

const knowledgeAddDrive: Tool<{ id: string }> = {
  name: 'knowledge_add_drive',
  description: 'Drive file store mein daalo — abhi band (Phase 5).',
  args: 'id: string',
  schema: z.object({ id: z.string().max(120) }),
  async run(_args, ctx) {
    return recordRefusal('knowledge_add_drive', NOT_YET, ctx);
  },
};

const knowledgeList: Tool<Record<string, never>> = {
  name: 'knowledge_list',
  description: 'Store ki documents dikhao — abhi band (Phase 5).',
  args: '(koi argument nahi)',
  schema: z.object({}),
  async run(_args, ctx) {
    return recordRefusal('knowledge_list', NOT_YET, ctx);
  },
};

const knowledgeForget: Tool<{ name: string }> = {
  name: 'knowledge_forget',
  description: 'Document store se hatao — abhi band (Phase 5).',
  args: 'name: string',
  schema: z.object({ name: z.string().max(200) }),
  async run(_args, ctx) {
    return recordRefusal('knowledge_forget', NOT_YET, ctx);
  },
};

export const knowledgeTools: Tool<any>[] = [
  knowledgeSearch,
  knowledgeAddUrl,
  knowledgeAddDrive,
  knowledgeList,
  knowledgeForget,
];
