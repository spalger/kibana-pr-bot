import apm from 'elastic-apm-node'
import {
  createMicroHandler,
  NotFoundError,
  ReqContext,
} from '@spalger/micro-plus'

import {
  createRootLog,
  assignRootLogger,
  getRequestLogger,
  createRootClient,
  logEsClientReponseErrors,
  assignEsClient,
  getRequestId,
} from './lib'
import { routes } from './routes'
import { IncomingMessage } from 'http'

const startTimes = new WeakMap<IncomingMessage, number>()

export function app() {
  const es = createRootClient(null)
  const log = createRootLog(es)
  logEsClientReponseErrors(es, log)

  const ctxForResponse = new WeakMap<IncomingMessage, ReqContext>()

  const handler = createMicroHandler({
    onRequest(ctx) {
      // ensure request id is generated
      getRequestId(ctx)
      assignEsClient(ctx, es)
      assignRootLogger(ctx, log)
    },
    routes,
    hooks: {
      onRequest(request) {
        startTimes.set(request, Date.now())
      },
      onRequestParsed(ctx, req) {
        ctxForResponse.set(req, ctx)
        apm.startTransaction(`${ctx.method} ${ctx.pathname}`)
      },
      onResponse() {
        // noop
      },
      onError(error) {
        if (error instanceof NotFoundError) {
          return
        }

        apm.captureError(error)
      },
      beforeSend(request, response) {
        const endTime = Date.now()
        const reqTime = endTime - startTimes.get(request)!
        const ctx = ctxForResponse.get(request)
        const maybeReqLog = ctx ? getRequestLogger(ctx) : log

        if (ctx) {
          response.setHeader('X-Request-ID', getRequestId(ctx))
        }

        maybeReqLog.info(
          `${request.method} ${request.url} - ${response.statusCode} ${reqTime}ms`,
          {
            '@type': 'request',
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

  return { log, handler }
}
