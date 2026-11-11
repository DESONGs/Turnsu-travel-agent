package app.travelagent.core;

import java.util.List;
import java.util.Map;
import org.springframework.core.io.ClassPathResource;
import tools.jackson.core.type.TypeReference;
import tools.jackson.databind.json.JsonMapper;

/** The Java service and UI consume the same published component contract. */
public final class WorkbenchCatalog {
    private static final Map<String, Object> CONTRACT = load();
    private WorkbenchCatalog() {}
    private static Map<String, Object> load() {
        try {
            return JsonMapper.builder().build().readValue(new ClassPathResource("contracts/travel-workbench.json").getContentAsByteArray(), new TypeReference<Map<String, Object>>() {});
        } catch (Exception error) { throw new IllegalStateException("Travel component contract is missing or invalid", error); }
    }
    @SuppressWarnings("unchecked")
    public static List<Map<String, Object>> components() { return (List<Map<String, Object>>) CONTRACT.get("components"); }
    public static List<String> registeredTypes() { return components().stream().map(c -> (String) c.get("type")).toList(); }
    public static List<String> fixedTypes() { return components().stream().filter(c -> Boolean.TRUE.equals(c.get("fixed"))).map(c -> (String) c.get("type")).toList(); }
    public static int version(String type) { return ((Number) components().stream().filter(c -> type.equals(c.get("type"))).findFirst().orElseThrow().get("version")).intValue(); }
    public static boolean supports(Map<?, ?> component) {
        Object supplied = component.get("version");
        return components().stream().anyMatch(c -> c.get("type").equals(component.get("type"))
                && (supplied == null || supplied instanceof Number number && number.doubleValue() == ((Number) c.get("version")).doubleValue()));
    }
    public static Map<String, Object> view() { return CONTRACT; }
}
