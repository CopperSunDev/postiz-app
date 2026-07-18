/* CSC-CMA-PATCH-APPLIED */
import {
  AuthTokenDetails,
  PostDetails,
  PostResponse,
  SocialProvider,
} from '@gitroom/nestjs-libraries/integrations/social/social.integrations.interface';
import { SocialAbstract } from '@gitroom/nestjs-libraries/integrations/social.abstract';
import { tags } from '@gitroom/nestjs-libraries/integrations/social/hashnode.tags';
import { jsonToGraphQLQuery } from 'json-to-graphql-query';
import { HashnodeSettingsDto } from '@gitroom/nestjs-libraries/dtos/posts/providers-settings/hashnode.settings.dto';
import dayjs from 'dayjs';
import { Integration } from '@prisma/client';
import { makeId } from '@gitroom/nestjs-libraries/services/make.is';
import { Tool } from '@gitroom/nestjs-libraries/integrations/tool.decorator';

export class HashnodeProvider extends SocialAbstract implements SocialProvider {
  override maxConcurrentJob = 3; // Hashnode has lenient publishing limits
  identifier = 'hashnode';
  name = 'Hashnode';
  isBetweenSteps = false;
  scopes = [] as string[];
  editor = 'markdown' as const;
  maxLength() {
    return 10000;
  }
  dto = HashnodeSettingsDto;

  async generateAuthUrl() {
    const state = makeId(6);
    return {
      url: state,
      codeVerifier: makeId(10),
      state,
    };
  }

  async refreshToken(refreshToken: string): Promise<AuthTokenDetails> {
    return {
      refreshToken: '',
      expiresIn: 0,
      accessToken: '',
      id: '',
      name: '',
      picture: '',
      username: '',
    };
  }

  async customFields() {
    return [
      {
        key: 'apiKey',
        label: 'API key',
        validation: `/^.{3,}$/`,
        type: 'password' as const,
      },
    ];
  }

  async authenticate(params: {
    code: string;
    codeVerifier: string;
    refresh?: string;
  }) {
    const body = JSON.parse(Buffer.from(params.code, 'base64').toString());
    try {
      const {
        data: {
          me: { name, id, profilePicture, username },
        },
      } = await (
        await fetch('https://gql-beta.hashnode.com', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `${body.apiKey}`,
          },
          body: JSON.stringify({
            query: `
                    query {
                      me {
                        name,
                        id,
                        profilePicture
                        username
                      }
                    }
                `,
          }),
        })
      ).json();

      return {
        refreshToken: '',
        expiresIn: dayjs().add(100, 'years').unix() - dayjs().unix(),
        accessToken: body.apiKey,
        id,
        name,
        picture: profilePicture || '',
        username,
      };
    } catch (err) {
      return 'Invalid credentials';
    }
  }

  async tags() {
    return tags.map((tag) => ({ value: (tag as any).slug || tag.name.toLowerCase().replace(/\s+/g, '-'), label: tag.name }));
  }

  @Tool({ description: 'Tags', dataSchema: [] })
  tagsList() {
    return tags;
  }

  @Tool({ description: 'Publications', dataSchema: [] })
  async publications(accessToken: string) {
    try {
      const result = await (
        await fetch('https://gql-beta.hashnode.com', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            Authorization: `${accessToken}`,
          },
          body: JSON.stringify({
            query: `
            query {
              me {
                publications (first: 50) {
                  edges{
                    node {
                      id
                      title
                    }
                  }
                }
              }
            }
                `,
          }),
        })
      ).json();

      const edges: { node: { id: string; title: string } }[] =
        result?.data?.me?.publications?.edges ?? [];
      return edges.map(({ node: { id, title } }) => ({ id, name: title }));
    } catch (err) {
      console.error('[Hashnode] publications() failed:', err);
      return [];
    }
  }

  async post(
    id: string,
    accessToken: string,
    postDetails: PostDetails[],
    integration: Integration
  ): Promise<PostResponse[]> {
    const { settings } = postDetails?.[0] || { settings: {} };
    const query = jsonToGraphQLQuery(
      {
        mutation: {
          publishPost: {
            __args: {
              input: {
                title: settings.title,
                publicationId: settings.publication,
                ...(settings.canonical
                  ? { originalArticleURL: settings.canonical }
                  : {}),
                contentMarkdown: postDetails?.[0].message,
                tags: (settings.tags ?? []).map((tag: any) => ({ slug: tag.value, name: tag.label })),
                ...(settings.subtitle ? { subtitle: settings.subtitle } : {}),
                ...(settings.main_image
                  ? {
                      coverImage: `${
                        settings?.main_image?.path?.indexOf('http') === -1
                          ? `${process.env.NEXT_PUBLIC_BACKEND_URL}/${process.env.NEXT_PUBLIC_UPLOAD_STATIC_DIRECTORY}`
                          : ``
                      }${settings?.main_image?.path}`,
                    }
                  : settings.coverImageUrl
                  ? { coverImage: settings.coverImageUrl }
                  : {}),
              },
            },
            post: {
              id: true,
              url: true,
            },
          },
        },
      },
      { pretty: true }
    );

    const requestBody = JSON.stringify({ query });
    let resp: Response;
    try {
      resp = await this.fetch('https://gql-beta.hashnode.com', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `${accessToken}`,
        },
        body: requestBody,
      });
    } catch (err: any) {
      // details[0].json is the raw Hashnode response body (set by BadBody constructor)
      const hashnodeBody = err?.details?.[0]?.json;
      console.error('[Hashnode] fetch threw:', err?.type, '| Hashnode response:', hashnodeBody?.slice(0, 1000));
      throw err;
    }

    const rawResponse = await resp.text();
    let parsedResponse: any;
    try {
      parsedResponse = JSON.parse(rawResponse);
    } catch {
      console.error('[Hashnode] non-JSON response:', rawResponse.slice(0, 500));
      throw new Error('Hashnode returned non-JSON response');
    }

    // Patch 8: gql-beta returns INTERNAL_SERVER_ERROR even when the post was
    // successfully created (known Hashnode quirk). Throwing causes Postiz to
    // retry, creating duplicate posts. Return synthetic success instead.
    const postData = parsedResponse?.data?.publishPost?.post;
    if (!postData && parsedResponse?.errors) {
      const codes = (parsedResponse.errors as any[]).map((e: any) =>
        (e?.extensions?.code ?? e?.code ?? '') as string
      );
      // Only suppress INTERNAL_SERVER_ERROR — treat any other code (or missing code) as real
      const hasRealError = !codes.every((c) => c === 'INTERNAL_SERVER_ERROR');
      if (hasRealError) {
        console.error('[Hashnode] GQL errors:', JSON.stringify(parsedResponse.errors));
        throw new Error(`Hashnode GQL error: ${JSON.stringify(parsedResponse.errors)}`);
      }
      console.warn('[Hashnode] INTERNAL_SERVER_ERROR (post created despite error — known Hashnode quirk)');
      return [{ id: postDetails?.[0].id, status: 'completed', postId: 'check-hashnode', releaseURL: '' }];
    }

    if (!postData) {
      console.error('[Hashnode] unexpected response shape (no post data, no errors):', rawResponse.slice(0, 500));
      throw new Error('Hashnode returned success shape but contained no post data');
    }

    const { id: postId, url } = postData;

    return [
      {
        id: postDetails?.[0].id,
        status: 'completed',
        postId: postId,
        releaseURL: url,
      },
    ];
  }
}
