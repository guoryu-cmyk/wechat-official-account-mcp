import { WechatToolDefinition, McpTool, WechatApiClient, WechatToolContext, WechatToolResult } from '../types.js';
import { logger } from '../../utils/logger.js';
import { z } from 'zod';
import { draftArticleSchema, mediaIdSchema } from '../../utils/validation.js';

// 草稿工具参数 Schema
const draftToolSchema = z.object({
  action: z.enum(['add', 'update', 'get', 'delete', 'list', 'count']),
  mediaId: mediaIdSchema.optional(),
  articles: z.array(draftArticleSchema).optional(),
  article: draftArticleSchema.optional(),
  index: z.number().int().min(0).optional(),
  truncateContent: z.boolean().optional(),
  offset: z.number().int().min(0).optional(),
  count: z.number().int().min(1).max(20).optional(),
});

function toWechatDraftArticle(article: any): Record<string, unknown> {
  // 微信草稿接口使用下划线字段；MCP 入参保持当前项目已有的驼峰字段，统一在这里转换。
  return {
    title: article.title,
    author: article.author || '',
    digest: article.digest || '',
    content: article.content,
    content_source_url: article.contentSourceUrl || '',
    thumb_media_id: article.thumbMediaId,
    show_cover_pic: article.showCoverPic || 0,
    need_open_comment: article.needOpenComment || 0,
    only_fans_can_comment: article.onlyFansCanComment || 0,
  };
}

/**
 * 格式化草稿正文。
 *
 * 默认返回微信接口给出的完整 HTML 内容，保证迁移、备份、二次编辑等场景不会丢正文。
 * 只有调用方明确要求预览时，才截断为 100 个字符，避免旧的摘要展示场景刷屏。
 */
function formatDraftContent(content: string, truncateContent = false): string {
  if (!truncateContent || content.length <= 100) {
    return content;
  }

  return `${content.substring(0, 100)}...`;
}

/**
 * 草稿工具核心处理逻辑
 * 统一处理所有草稿相关操作
 */
async function handleDraftOperations(
  action: string,
  params: {
    mediaId?: string;
    articles?: any[];
    article?: any;
    index?: number;
    truncateContent?: boolean;
    offset?: number;
    count?: number;
  },
  apiClient: WechatApiClient
): Promise<WechatToolResult> {
  switch (action) {
    case 'add': {
      const { articles } = params;

      if (!articles || articles.length === 0) {
        throw new Error('文章内容不能为空');
      }

      try {
        const result = await apiClient.post('/cgi-bin/draft/add', {
          articles: articles.map(toWechatDraftArticle)
        }) as any;

        return {
          structuredContent: {
            ok: true,
            action: 'add',
            mediaId: result.media_id,
            articleCount: articles.length,
          },
          content: [{
            type: 'text',
            text: `草稿创建成功！\n草稿ID: ${result.media_id}\n包含文章数: ${articles.length}`,
          }],
        };
      } catch (error) {
        throw new Error(`创建草稿失败: ${error instanceof Error ? error.message : '未知错误'}`);
      }
    }

    case 'update': {
      const { mediaId, article, index = 0 } = params;

      if (!mediaId) {
        throw new Error('草稿ID不能为空');
      }

      if (!article) {
        throw new Error('文章内容不能为空');
      }

      try {
        await apiClient.post('/cgi-bin/draft/update', {
          media_id: mediaId,
          index,
          articles: toWechatDraftArticle(article),
        }) as any;

        return {
          structuredContent: {
            ok: true,
            action: 'update',
            mediaId,
            index,
          },
          content: [{
            type: 'text',
            text: `草稿修改成功！\n草稿ID: ${mediaId}\n文章位置: ${index}`,
          }],
        };
      } catch (error) {
        throw new Error(`修改草稿失败: ${error instanceof Error ? error.message : '未知错误'}`);
      }
    }

    case 'get': {
      const { mediaId, truncateContent = false } = params;

      if (!mediaId) {
        throw new Error('草稿ID不能为空');
      }

      try {
        const result = await apiClient.post('/cgi-bin/draft/get', {
          media_id: mediaId
        }) as any;

        const articles = result.news_item.map((item: any, index: number) =>
          `第${index + 1}篇:\n` +
          `标题: ${item.title}\n` +
          `作者: ${item.author || '未设置'}\n` +
          `摘要: ${item.digest || '无'}\n` +
          `内容: ${formatDraftContent(item.content, truncateContent)}\n` +
          `原文链接: ${item.content_source_url || '无'}\n` +
          `封面图ID: ${item.thumb_media_id}\n` +
          `显示封面: ${item.show_cover_pic ? '是' : '否'}\n`
        ).join('\n');

        return {
          content: [{
            type: 'text',
            text: `获取草稿成功！\n草稿ID: ${mediaId}\n创建时间: ${new Date(result.create_time * 1000).toLocaleString()}\n更新时间: ${new Date(result.update_time * 1000).toLocaleString()}\n\n${articles}`,
          }],
        };
      } catch (error) {
        throw new Error(`获取草稿失败: ${error instanceof Error ? error.message : '未知错误'}`);
      }
    }

    case 'delete': {
      const { mediaId } = params;

      if (!mediaId) {
        throw new Error('草稿ID不能为空');
      }

      try {
        await apiClient.post('/cgi-bin/draft/delete', {
          media_id: mediaId
        }) as any;

        return {
          content: [{
            type: 'text',
            text: `草稿删除成功！\n草稿ID: ${mediaId}`,
          }],
        };
      } catch (error) {
        throw new Error(`删除草稿失败: ${error instanceof Error ? error.message : '未知错误'}`);
      }
    }

    case 'list': {
      const { offset = 0, count = 20 } = params;

      try {
        const result = await apiClient.post('/cgi-bin/draft/batchget', {
          offset,
          count
        }) as any;

        const draftList = result.item.map((item: any, index: number) => {
          const firstArticle = item.content.news_item[0];
          const articleCount = item.content.news_item.length;

          return `${offset + index + 1}. 草稿ID: ${item.media_id}\n` +
                 `   标题: ${firstArticle.title}${articleCount > 1 ? ` (共${articleCount}篇)` : ''}\n` +
                 `   作者: ${firstArticle.author || '未设置'}\n` +
                 `   创建时间: ${new Date(item.content.create_time * 1000).toLocaleString()}\n` +
                 `   更新时间: ${new Date(item.content.update_time * 1000).toLocaleString()}`;
        }).join('\n\n');

        return {
          content: [{
            type: 'text',
            text: `草稿列表 (${offset + 1}-${offset + result.item.length}/${result.total_count}):\n\n${draftList}`,
          }],
        };
      } catch (error) {
        throw new Error(`获取草稿列表失败: ${error instanceof Error ? error.message : '未知错误'}`);
      }
    }

    case 'count': {
      try {
        const result = await apiClient.post('/cgi-bin/draft/count') as any;

        return {
          content: [{
            type: 'text',
            text: `草稿统计信息：\n草稿总数: ${result.total_count} 个`,
          }],
        };
      } catch (error) {
        throw new Error(`获取草稿统计失败: ${error instanceof Error ? error.message : '未知错误'}`);
      }
    }

    default:
      throw new Error(`Unknown action: ${action}`);
  }
}

/**
 * 草稿工具处理器 (WechatToolContext)
 */
async function handleDraftTool(context: WechatToolContext): Promise<WechatToolResult> {
  const { args, apiClient } = context;

  try {
    const validatedArgs = draftToolSchema.parse(args);
    const { action, mediaId, articles, article, index, truncateContent, offset, count } = validatedArgs;

    return await handleDraftOperations(action, { mediaId, articles, article, index, truncateContent, offset, count }, apiClient);
  } catch (error) {
    logger.error('Draft tool error:', error);
    return {
      content: [{
        type: 'text',
        text: `草稿操作失败: ${error instanceof Error ? error.message : '未知错误'}`,
      }],
      isError: true,
    };
  }
}

/**
 * MCP草稿工具处理器 (直接参数)
 */
async function handleDraftMcpTool(args: unknown, apiClient: WechatApiClient): Promise<WechatToolResult> {
  const { action, mediaId, articles, article, index, truncateContent, offset = 0, count = 20 } = args as any;

  try {
    const validatedArgs = draftToolSchema.parse({
      action,
      mediaId,
      articles,
      article,
      index,
      truncateContent,
      offset,
      count,
    });

    return await handleDraftOperations(validatedArgs.action, {
      mediaId: validatedArgs.mediaId,
      articles: validatedArgs.articles,
      article: validatedArgs.article,
      index: validatedArgs.index,
      truncateContent: validatedArgs.truncateContent,
      offset: validatedArgs.offset,
      count: validatedArgs.count,
    }, apiClient);
  } catch (error) {
    logger.error('Draft MCP tool error:', error);
    return {
      content: [{
        type: 'text',
        text: `草稿操作失败: ${error instanceof Error ? error.message : '未知错误'}`,
      }],
      isError: true,
    };
  }
}

/**
 * 微信公众号草稿管理工具
 */
export const draftTool: WechatToolDefinition = {
  name: 'wechat_draft',
  description: '管理微信公众号草稿',
  inputSchema: {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['add', 'update', 'get', 'delete', 'list', 'count'],
        description: '操作类型',
      },
      mediaId: {
        type: 'string',
        description: '草稿 Media ID',
      },
      truncateContent: {
        type: 'boolean',
        description: '获取草稿时是否将正文截断为 100 字预览；默认 false，返回全文',
      },
    },
    required: ['action'],
  },
  handler: handleDraftTool,
};

/**
 * MCP草稿工具
 */
export const draftMcpTool: McpTool = {
  name: 'wechat_draft',
  description: '管理微信公众号草稿',
  inputSchema: {
    action: z.enum(['add', 'update', 'get', 'delete', 'list', 'count']).describe('操作类型：add(创建), update(修改), get(获取), delete(删除), list(列表), count(统计)'),
    mediaId: z.string().optional().describe('草稿 Media ID（获取、修改、删除时必需）'),
    articles: z.array(z.object({
      title: z.string().describe('文章标题'),
      author: z.string().optional().describe('作者'),
      digest: z.string().optional().describe('摘要'),
      content: z.string().describe('文章内容'),
      contentSourceUrl: z.string().optional().describe('原文链接'),
      thumbMediaId: z.string().describe('封面图片媒体ID'),
      showCoverPic: z.number().optional().describe('是否显示封面图片'),
      needOpenComment: z.number().optional().describe('是否开启评论'),
      onlyFansCanComment: z.number().optional().describe('是否仅粉丝可评论'),
    })).optional().describe('文章列表（创建时必需）'),
    article: draftArticleSchema.optional().describe('文章内容（修改单篇草稿时必需）'),
    index: z.number().int().min(0).optional().describe('文章位置（修改草稿时使用，首篇为0，默认0）'),
    truncateContent: z.boolean().optional().describe('获取草稿时是否将正文截断为 100 字预览；默认 false，返回全文'),
    offset: z.number().optional().describe('偏移量（列表时使用）'),
    count: z.number().optional().describe('数量（列表时使用）'),
  },
  handler: handleDraftMcpTool,
};
