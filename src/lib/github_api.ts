import Axios, { AxiosResponse, Method } from 'axios'
import parseLinkHeader from 'parse-link-header'
import { getConfigVar } from '@spalger/micro-plus'
import gql from 'graphql-tag'
import { print } from 'graphql/language/printer'
import { ASTNode } from 'graphql/language/ast'

import { Log } from '../lib'
import {
  GithubApiPr,
  GithubApiCompare,
  Commit,
  GithubApiCompareCommit,
  CombinedCommitStatus,
  GithubApiPullRequestFiles,
} from '../github_api_types'
import { makeContextCache } from './req_cache'
import { getRequestLogger } from './log'
import { isAxiosErrorReq, isAxiosErrorResp } from './axios_errors'

const RATE_LIMIT_THROTTLE_MS = 10 * 1000
const DEFAULT_RETRY_ON_502_ATTEMPTS = 3
const sleep = async (ms: number) =>
  await new Promise(resolve => setTimeout(resolve, ms))

type COMMIT_STATUS_STATE = 'error' | 'pending' | 'success' | 'failure'

interface CommitStatusOptions {
  state: COMMIT_STATUS_STATE
  context: string
  description?: string
  target_url?: string
}

export type FileReq = {
  id: number
  filesEndCursor: string
  files?: string[]
}
export type OutdatedPr = {
  id: number
  updatedSinceCommit: true
  files?: undefined
}
export type PrWithFiles = {
  id: number
  updatedSinceCommit: false
  files: string[]
}

const getCommitDate = (commit: Commit) => {
  const committerDate = new Date(commit.committer.date)
  const authorDate = new Date(commit.author.date)
  return committerDate > authorDate ? committerDate : authorDate
}

export class GithubApi {
  private readonly ax = Axios.create({
    baseURL: 'https://api.github.com/',
    headers: {
      'User-Agent': 'spalger/kibana-pr-bot',
      Authorization: `token ${this.secret}`,
      Accept: 'application/vnd.github.shadow-cat-preview',
    },
  })

  public constructor(
    private readonly log: Log,
    private readonly secret: string,
  ) {}

  public async getMissingCommits(
    refToStartFrom: string,
    refWithNewCommits: string,
  ): Promise<{
    totalMissingCommits: number
    missingCommits: GithubApiCompareCommit[]
  }> {
    const startComponent = encodeURIComponent(refToStartFrom)
    const newCommitsComponent = encodeURIComponent(refWithNewCommits)
    const url = `/repos/elastic/kibana/compare/${startComponent}...${newCommitsComponent}`

    const resp = await this.get<GithubApiCompare>(url)

    const { ahead_by: totalMissingCommits, commits: missingCommits } = resp.data

    if (totalMissingCommits > 0 && !missingCommits.length) {
      this.log.error(
        'unexpected github response, expected oldest missing commit',
        {
          totalMissingCommits,
          respBody: resp.data,
        },
      )

      throw new Error('Unexpected github response')
    }

    return {
      totalMissingCommits,
      missingCommits,
    }
  }

  public async getCommitDate(ref: string) {
    const refComponent = encodeURIComponent(ref)
    const resp = await this.get(`/repos/elastic/kibana/commits/${refComponent}`)
    return getCommitDate(resp.data.commit)
  }

  public async setCommitStatus(ref: string, options: CommitStatusOptions) {
    const shaComponent = encodeURIComponent(ref)
    const url = `/repos/elastic/kibana/statuses/${shaComponent}`
    await this.post(url, {}, options)
  }

  public async getCommitStatus(ref: string) {
    const shaComponent = encodeURIComponent(ref)
    const url = `/repos/elastic/kibana/commits/${shaComponent}/status`
    const resp = await this.get<CombinedCommitStatus>(url, {})
    return resp.data
  }

  public async getPr(prId: number) {
    const prIdComponent = encodeURIComponent(`${prId}`)
    const resp = await this.get<GithubApiPr>(
      `/repos/elastic/kibana/pulls/${prIdComponent}`,
    )
    return resp.data
  }

  public async getPrsAndFiles(
    commitSha: string,
    state: 'open' | 'closed' = 'open',
  ) {
    type ResponseType = {
      search: {
        nodes: Array<{
          __typename: 'PullRequest'
          number: number
          commits: {
            nodes: Array<{
              commit: {
                oid: string
              }
            }>
          }
          files: {
            nodes: Array<{
              path: string
            }>
            pageInfo: {
              hasNextPage: boolean
              endCursor: string
            }
          }
        }>
      }
    }

    const resp = await this.gql<ResponseType>(
      gql`
        query($query: String!) {
          search(first: 100, query: $query, type: ISSUE) {
            nodes {
              __typename
              ... on PullRequest {
                number
                commits(last: 1) {
                  nodes {
                    commit {
                      oid
                    }
                  }
                }
                files(first: 100) {
                  nodes {
                    path
                  }
                  pageInfo {
                    hasNextPage
                    endCursor
                  }
                }
              }
            }
          }
        }
      `,
      {
        query: `${commitSha} state:${state}`,
      },
    )

    const restOfFilesReqs: FileReq[] = []
    const prs: Array<OutdatedPr | PrWithFiles> = []

    for (const n of resp.search.nodes) {
      const lastSha = n.commits.nodes.map(nn => nn.commit.oid).shift()
      if (lastSha !== commitSha) {
        prs.push({
          id: n.number,
          updatedSinceCommit: true,
        })
        continue
      }

      prs.push({
        id: n.number,
        updatedSinceCommit: false,
        // placeholder, will be replaced once rest of files are fetched
        files: [],
      })
      restOfFilesReqs.push({
        id: n.number,
        files: n.files.nodes.map(nn => nn.path),
        filesEndCursor: n.files.pageInfo.endCursor,
      })
    }

    const allFiles = await this.getRestOfFiles(restOfFilesReqs)
    return prs.map(pr => {
      const files = allFiles.get(pr.id)
      return files ? ({ ...pr, files } as PrWithFiles) : (pr as OutdatedPr)
    })
  }

  public async getRestOfFiles(reqs: FileReq[]): Promise<Map<number, string[]>> {
    // array of requests that will be fetched, on each fetch the array is cleared and reloaded with info to fetch the subsequent pages
    const nextReqs = reqs.slice()

    // map of all files for the requested pr ids
    const allFiles = new Map(reqs.map(r => [r.id, r.files || []]))

    while (nextReqs.length) {
      const batch = nextReqs.splice(0)

      type RepsonseType = {
        repository: {
          [prKey: string]: {
            number: number
            files: {
              nodes: Array<{
                path: string
              }>
              pageInfo: {
                endCursor: string
                hasNextPage: boolean
              }
            }
          }
        }
      }

      let queries = ''
      const vars: Array<{
        name: string
        type: string
        value: string | number
      }> = []
      for (const [i, { id, filesEndCursor }] of batch.entries()) {
        queries = `${queries}
          req${i}: pullRequest(number: $num${i}) {
            number
            files(first: 100, after: $after${i}) {
              nodes {
                path
              }
              pageInfo {
                endCursor
                hasNextPage
              }
            }
          }
        `
        vars.push(
          {
            name: `num${i}`,
            type: 'Int!',
            value: id,
          },
          {
            name: `after${i}`,
            type: 'String!',
            value: filesEndCursor,
          },
        )
      }

      const args = vars.map(v => `$${v.name}: ${v.type}`)
      const moreFilesResp = await this.gql<RepsonseType>(
        gql`query(${args.join(',')}) {
          repository(owner: "elastic", name: "kibana") {${queries}}
        }`,
        Object.fromEntries(vars.map(v => [v.name, v.value])),
      )

      for (const resp of Object.values(moreFilesResp.repository)) {
        allFiles.set(resp.number, [
          ...(allFiles.get(resp.number) || []),
          ...resp.files.nodes.map(n => n.path),
        ])

        if (resp.files.pageInfo.hasNextPage) {
          nextReqs.push({
            id: resp.number,
            filesEndCursor: resp.files.pageInfo.endCursor,
          })
        }
      }
    }

    return allFiles
  }

  public async getPrFiles(prId: number) {
    const prIdComponent = encodeURIComponent(`${prId}`)
    const resp = await this.get<GithubApiPullRequestFiles>(
      `/repos/elastic/kibana/pulls/${prIdComponent}/files`,
    )
    return resp.data
  }

  public async *ittrAllOpenPrs() {
    const urls: (string | null)[] = [null]

    const fetchInitialPage = async () => {
      this.log.info('fetching initial page of PRs')
      return await this.get<GithubApiPr[]>('/repos/elastic/kibana/pulls', {
        state: 'open',
      })
    }

    const fetchNextPage = async (url: string) => {
      console.log('fetching page of PRs', url)
      return await this.get<GithubApiPr[]>(url)
    }

    while (urls.length) {
      const url = urls.shift()!
      const page = await (url !== null
        ? fetchNextPage(url)
        : fetchInitialPage())

      for (const pr of page.data) {
        yield pr
      }

      if (!page.headers['link']) {
        throw new Error('missing link header')
      }

      const links = parseLinkHeader(page.headers['link'])
      if (!links) {
        throw new Error('unable to parse link header')
      }

      if (links.next) {
        urls.push(links.next.url)
      }
    }
  }

  public async gql<T extends object>(
    query: ASTNode,
    variables: Record<string, any>,
  ) {
    const resp = await this.ax.request<{ data: T; errors?: unknown }>({
      url: 'https://api.github.com/graphql',
      method: 'POST',
      headers: {
        Authorization: `bearer ${this.secret}`,
      },
      data: {
        query: print(query),
        variables,
      },
    })

    if (resp.data.errors) {
      throw new Error(`Graphql Errors: ${JSON.stringify(resp.data.errors)}`)
    }

    this.checkForGqlRateLimitInfo(resp.data.data)

    return resp.data.data
  }

  private async req<Result = any>(
    method: Method,
    url: string,
    params?: { [key: string]: any },
    body?: { [key: string]: any },
    retryOn502Attempts: number = DEFAULT_RETRY_ON_502_ATTEMPTS,
  ): Promise<AxiosResponse<Result>> {
    try {
      const resp = await this.ax({
        method,
        url,
        params,
        data: body,
      })

      this.checkForRateLimitInfo(resp)

      return resp
    } catch (error) {
      if (isAxiosErrorResp(error)) {
        this.checkForRateLimitInfo(error.response)
        this.log.debug('github api response error', {
          '@type': 'githubApiResponseError',
          status: error.response.status,
          data: {
            method,
            url,
            params,
            body,
            response: {
              headers: error.response.headers,
              body: error.response.data,
              status: error.response.status,
              statusText: error.response.statusText,
            },
          },
        })

        if (error.response.status === 502 && retryOn502Attempts > 0) {
          const attempt = DEFAULT_RETRY_ON_502_ATTEMPTS - retryOn502Attempts
          const delay = 2000 * attempt

          this.log.debug('automatically retrying request', {
            '@type': 'githubApi502Retry',
            status: error.response.status,
            delay,
            retryOn502Attempts,
            data: {
              method,
              url,
              params,
              body,
            },
          })

          await sleep(delay)
          return this.req<Result>(
            method,
            url,
            params,
            body,
            retryOn502Attempts - 1,
          )
        }
      } else if (isAxiosErrorReq(error)) {
        this.log.debug('github api request error', {
          '@type': 'githubApiRequestError',
          errorMessage: error.message,
          data: {
            method,
            url,
            params,
            body,
          },
        })
      }

      throw error
    }
  }

  private checkForRateLimitInfo(resp: AxiosResponse<any>) {
    if (
      resp.headers &&
      resp.headers['x-ratelimit-limit'] &&
      resp.headers['x-ratelimit-remaining']
    ) {
      this.logRateLimitInfo(
        Number.parseFloat(resp.headers['x-ratelimit-remaining']),
        Number.parseFloat(resp.headers['x-ratelimit-limit']),
      )
    }
  }

  private checkForGqlRateLimitInfo(resp: {
    rateLimit?: {
      limit?: number
      remaining?: number
    }
  }) {
    if (
      resp.rateLimit &&
      resp.rateLimit.limit !== undefined &&
      resp.rateLimit.remaining !== undefined
    ) {
      this.logRateLimitInfo(resp.rateLimit.remaining, resp.rateLimit.limit)
    }
  }

  private async get<Result = any>(
    url: string,
    params?: { [key: string]: any },
  ) {
    return this.req<Result>('get', url, params)
  }

  private async post<Result = any>(
    url: string,
    params?: { [key: string]: any },
    body?: { [key: string]: any },
  ) {
    return this.req<Result>('post', url, params, body)
  }

  private rateLimitLogThrottled?: {
    timer: NodeJS.Timer
    nextArgs?: [number, number]
  }

  private logRateLimitInfo(remaining: number, total: number) {
    if (this.rateLimitLogThrottled) {
      this.rateLimitLogThrottled.nextArgs = [remaining, total]
      return
    }

    this.rateLimitLogThrottled = {
      timer: setTimeout(() => {
        const { nextArgs } = this.rateLimitLogThrottled!
        this.rateLimitLogThrottled = undefined

        if (nextArgs) {
          this.logRateLimitInfo(...nextArgs)
        }
      }, RATE_LIMIT_THROTTLE_MS),
    }

    // don't keep the process open just to log rate limit
    this.rateLimitLogThrottled.timer.unref()

    this.log.info(`rate limit ${remaining}/${total}`, {
      type: 'githubRateLimit',
      rateLimit: {
        remaining,
        total,
      },
    })
  }
}

const githubApiCache = makeContextCache('github api', ctx => {
  return new GithubApi(getRequestLogger(ctx), getConfigVar('GITHUB_SECRET'))
})

export const getGithubApi = githubApiCache.get
export const assignGithubApi = githubApiCache.assignValue
