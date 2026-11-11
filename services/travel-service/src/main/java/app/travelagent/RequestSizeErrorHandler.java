package app.travelagent;

import java.nio.charset.StandardCharsets;
import org.springframework.core.annotation.Order;
import org.springframework.core.io.buffer.DataBufferLimitException;
import org.springframework.http.HttpStatus;
import org.springframework.http.MediaType;
import org.springframework.stereotype.Component;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebExceptionHandler;
import reactor.core.publisher.Mono;

/** Oversize input is rejected before parsing; never echo the request body in an error. */
@Component
@Order(-2)
public class RequestSizeErrorHandler implements WebExceptionHandler {
    private static final byte[] RESPONSE = "{\"error\":\"request_too_large\"}".getBytes(StandardCharsets.UTF_8);

    @Override public Mono<Void> handle(ServerWebExchange exchange, Throwable error) {
        Throwable cause = error;
        while (cause != null && !(cause instanceof DataBufferLimitException) && cause.getCause() != cause) cause = cause.getCause();
        if (!(cause instanceof DataBufferLimitException) || exchange.getResponse().isCommitted()) return Mono.error(error);
        var response = exchange.getResponse(); response.setStatusCode(HttpStatus.PAYLOAD_TOO_LARGE);
        response.getHeaders().setContentType(MediaType.APPLICATION_JSON); response.getHeaders().setCacheControl("no-store");
        return response.writeWith(Mono.just(response.bufferFactory().wrap(RESPONSE)));
    }
}
