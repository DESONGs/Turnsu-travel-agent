package app.travelagent.auth;

import app.travelagent.core.TravelError;
import org.springframework.context.annotation.Bean;
import org.springframework.context.annotation.Configuration;
import org.springframework.http.HttpHeaders;
import org.springframework.http.HttpStatus;
import org.springframework.security.config.web.server.ServerHttpSecurity;
import org.springframework.security.config.web.server.SecurityWebFiltersOrder;
import org.springframework.security.web.server.SecurityWebFilterChain;
import org.springframework.web.server.ServerWebExchange;
import org.springframework.web.server.WebFilter;
import reactor.core.publisher.Mono;
import reactor.core.scheduler.Schedulers;

@Configuration
public class McpSecurity {
    public static final String PRINCIPAL_ATTRIBUTE = McpSecurity.class.getName() + ".principal";

    @Bean
    SecurityWebFilterChain travelSecurity(ServerHttpSecurity http, OAuthGrants grants, OAuthSettings settings, WorkerSettings worker) {
        WebFilter authenticateMcp = (exchange, chain) -> {
            if (exchange.getRequest().getPath().value().startsWith("/internal/worker/")) {
                if (!worker.configured()) return status(exchange, HttpStatus.SERVICE_UNAVAILABLE);
                if (!worker.authenticates(exchange.getRequest().getHeaders().getFirst(HttpHeaders.AUTHORIZATION))) return status(exchange, HttpStatus.UNAUTHORIZED);
                return chain.filter(exchange);
            }
            if (!"/mcp".equals(exchange.getRequest().getPath().value())) return chain.filter(exchange);
            if (!settings.configured()) return status(exchange, HttpStatus.SERVICE_UNAVAILABLE);
            if (!settings.allowsHost(exchange.getRequest().getHeaders().getFirst(HttpHeaders.HOST))) return status(exchange, HttpStatus.FORBIDDEN);
            if (!settings.allowsBrowserOrigin(exchange.getRequest().getHeaders().getOrigin())) return status(exchange, HttpStatus.FORBIDDEN);
            String authorization = exchange.getRequest().getHeaders().getFirst(HttpHeaders.AUTHORIZATION);
            if (authorization == null || !authorization.matches("(?i)Bearer [A-Za-z0-9_-]{43}")) return challenge(exchange, settings);
            String token = authorization.substring(7);
            return Mono.fromCallable(() -> grants.authenticate(token, "travel:read"))
                    .subscribeOn(Schedulers.boundedElastic())
                    .map(principal -> new AuthenticationOutcome(principal, null))
                    .onErrorResume(TravelError.class, error -> Mono.just(new AuthenticationOutcome(null, HttpStatus.UNAUTHORIZED)))
                    .onErrorResume(error -> Mono.just(new AuthenticationOutcome(null, HttpStatus.SERVICE_UNAVAILABLE)))
                    .flatMap(outcome -> {
                        if (outcome.status() == HttpStatus.UNAUTHORIZED) return challenge(exchange, settings);
                        if (outcome.status() != null) return status(exchange, outcome.status());
                        exchange.getAttributes().put(PRINCIPAL_ATTRIBUTE, outcome.principal());
                        return chain.filter(exchange);
                    });
        };
        return http.csrf(ServerHttpSecurity.CsrfSpec::disable)
                .httpBasic(ServerHttpSecurity.HttpBasicSpec::disable)
                .formLogin(ServerHttpSecurity.FormLoginSpec::disable)
                .logout(ServerHttpSecurity.LogoutSpec::disable)
                .authorizeExchange(rules -> rules.anyExchange().permitAll())
                .addFilterAt(authenticateMcp, SecurityWebFiltersOrder.AUTHENTICATION)
                .build();
    }

    private static Mono<Void> challenge(ServerWebExchange exchange, OAuthSettings settings) {
        exchange.getResponse().getHeaders().set(HttpHeaders.WWW_AUTHENTICATE,
                "Bearer resource_metadata=\"" + settings.issuer() + "/.well-known/oauth-protected-resource/mcp\"");
        return status(exchange, HttpStatus.UNAUTHORIZED);
    }

    private static Mono<Void> status(ServerWebExchange exchange, HttpStatus status) {
        exchange.getResponse().setStatusCode(status);
        return exchange.getResponse().setComplete();
    }

    private record AuthenticationOutcome(OAuthGrants.Principal principal, HttpStatus status) {}
}
