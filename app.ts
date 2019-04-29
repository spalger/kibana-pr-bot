import { ServerResponse } from 'http'

import {
  createMicroHandler,
  Route,
  NotFoundError,
  getConfigVar,
  BadRequestError,
} from '@spalger/micro-plus'
import apm from 'elastic-apm-node'

import {
  Log,
  assignRootLogger,
  getRequestLogger,
  initStartTime,
  getStartTime,
  requireDirectApiPassword,
} from './lib'

import { makeWebhookRoute, GithubApi, checkPr } from './webhook'

export function app(log: Log) {
  const githubApi = new GithubApi(log, getConfigVar('GITHUB_SECRET'))

  return createMicroHandler({
    onRequest(ctx) {
      assignRootLogger(ctx, log)
    },
    routes: [
      new Route('GET', '/', async () => ({
        status: 200,
        body: {
          hello: 'world',
        },
      })),
      makeWebhookRoute(githubApi),
      new Route(
        'GET',
        '/refresh',
        requireDirectApiPassword(async ctx => {
          const reqLog = getRequestLogger(ctx)

          return {
            status: 200,
            async body(response: ServerResponse) {
              response.connection.setNoDelay(true)

              const prs = githubApi.ittrAllOpenPrs()

              while (true) {
                if (!response.connection || response.connection.destroyed) {
                  return
                }

                const { value, done } = await prs.next()

                if (value) {
                  const result = await checkPr(reqLog, githubApi, value)
                  response.write(JSON.stringify(result, null, 2) + '\n\n')
                }

                if (done) {
                  response.end()
                  break
                }
              }
            },
          }
        }),
      ),
      new Route(
        'GET',
        '/check',
        requireDirectApiPassword(async ctx => {
          const reqLog = getRequestLogger(ctx)

          const prId = ctx.query.id
          if (!prId) {
            throw new BadRequestError('missing ?id= param')
          }

          if (typeof prId !== 'string' || !/^\d+$/.test(prId)) {
            throw new BadRequestError('invalid ?id= param')
          }

          const pr = await githubApi.getPr(Number.parseInt(prId, 10))
          return {
            status: 200,
            body: await checkPr(reqLog, githubApi, pr),
          }
        }),
      ),
    ],
    apmAgent: {
      onRequest(request) {
        initStartTime(request)
      },
      onRequestParsed(ctx) {
        apm.startTransaction(`${ctx.method} ${ctx.pathname}`)
      },
      onResponse() {},
      onError(error) {
        if (error instanceof NotFoundError) {
          return
        }

        apm.captureError(error)
      },
      beforeSend(request, response) {
        const endTime = Date.now()
        const reqTime = endTime - getStartTime(request)

        log.info(
          `${request.method} ${request.url} - ${
            response.statusCode
          } ${reqTime}ms`,
          {
            type: 'request',
            method: request.method,
            url: request.url,
            status: response.statusCode,
            timeMs: reqTime,
          },
        )

        apm.endTransaction(response.statusCode)
      },
    },
  })
}
