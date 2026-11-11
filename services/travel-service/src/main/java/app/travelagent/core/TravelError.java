package app.travelagent.core;

/** An intentionally non-sensitive error code suitable for a tool or HTTP response. */
public final class TravelError extends RuntimeException {
    private final String code;

    public TravelError(String code) {
        super(code);
        this.code = code;
    }

    public String code() {
        return code;
    }
}
