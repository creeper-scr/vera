import { errorMessageFrom } from '@moeru/std'

interface VeraClientLike {
  connect: () => Promise<void>
}

interface LoggerLike {
  log: (message: string) => void
  warn: (message: string) => void
  withFields: (fields: Record<string, unknown>) => LoggerLike
}

export function startVeraClientConnection(client: VeraClientLike, deps: {
  logger: LoggerLike
  url: string
}) {
  let unavailableReported = false

  const reportUnavailable = (error: unknown) => {
    if (unavailableReported)
      return

    unavailableReported = true
    deps.logger.withFields({
      url: deps.url,
      error: errorMessageFrom(error) ?? 'Unknown error',
    }).warn('Vera server is unavailable; continuing startup without Vera and retrying in background')
  }

  const reportDisconnected = () => {
    deps.logger.withFields({
      url: deps.url,
    }).warn('Vera server connection closed; retrying in background')
  }

  void client.connect()
    .then(() => {
      deps.logger.withFields({
        url: deps.url,
      }).log(
        unavailableReported
          ? 'Connected to Vera server after background retry'
          : 'Connected to Vera server',
      )
      unavailableReported = false
    })
    .catch((error) => {
      deps.logger.withFields({
        url: deps.url,
        error: errorMessageFrom(error) ?? 'Unknown error',
      }).warn('Vera client stopped retrying')
    })

  return {
    reportUnavailable,
    reportDisconnected,
  }
}
