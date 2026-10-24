export interface StreamPipeResult {
  response?: {
    status?: string;
    error?: {
      code?: string;
      message?: string;
    } | null;
  } | null;
}

export interface StreamOutcome {
  statusCode: number;
  errorCode?: string;
  errorMessage?: string;
}

export function classifyStreamOutcome(
  result: StreamPipeResult | undefined,
  thrownError?: unknown,
): StreamOutcome {
  if (thrownError) {
    return {
      statusCode: 500,
      errorCode: "stream_error",
      errorMessage: thrownError instanceof Error ? thrownError.message : String(thrownError),
    };
  }

  const response = result?.response;
  if (response?.status === "failed") {
    return {
      statusCode: 502,
      errorCode: response.error?.code || "upstream_stream_failed",
      errorMessage: response.error?.message || "upstream stream failed",
    };
  }

  if (response?.status === "incomplete") {
    return {
      statusCode: 499,
      errorCode: "client_disconnected",
      errorMessage: "client closed the response stream before completion",
    };
  }

  if (response?.status === "completed") {
    return { statusCode: 200 };
  }

  return {
    statusCode: 502,
    errorCode: "stream_incomplete",
    errorMessage: "upstream stream ended without response.completed",
  };
}
