package app.travelagent.mcp;

import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.util.HexFormat;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import org.springframework.core.io.ClassPathResource;
import org.springframework.stereotype.Component;
import tools.jackson.databind.json.JsonMapper;

/** Refuse a mixed service/UI build; immutable resource URIs identify the exact HTML. */
@Component
public final class WorkbenchUiAssets {
    public record Page(String kind, String uri, String html) {}
    private final Map<String, Page> pages;
    public WorkbenchUiAssets() {
        var manifestFile = new ClassPathResource("ui/build.json");
        if (!manifestFile.exists()) { pages = Map.of(); return; }
        try {
            var manifest = JsonMapper.builder().build().readTree(manifestFile.getContentAsByteArray());
            String version = manifest.path("version").asString();
            if (!version.matches("[0-9]+\\.[0-9]+\\.[0-9]+")) throw new IllegalStateException("Invalid UI version");
            byte[] contract = new ClassPathResource("contracts/travel-workbench.json").getContentAsByteArray();
            if (!hash(contract).equals(manifest.path("contractSha256").asString())) throw new IllegalStateException("UI component contract mismatch");
            var loaded = new LinkedHashMap<String, Page>();
            for (String kind : List.of("mcp", "codex")) {
                byte[] html = new ClassPathResource("ui/" + kind + ".html").getContentAsByteArray();
                String digest = hash(html), uri = "ui://travel/workbench/" + version + "/" + kind + "/" + digest.substring(0, 16) + ".html";
                if (!digest.equals(manifest.path("pages").path(kind).path("sha256").asString())
                        || !uri.equals(manifest.path("pages").path(kind).path("resourceUri").asString())) throw new IllegalStateException("UI content fingerprint mismatch");
                loaded.put(kind, new Page(kind, uri, new String(html, StandardCharsets.UTF_8)));
            }
            pages = Map.copyOf(loaded);
        } catch (Exception error) { throw new IllegalStateException("Build the matching travel workbench before starting the service", error); }
    }
    public boolean available() { return !pages.isEmpty(); }
    public Page page(String kind) { return pages.get(kind); }
    public List<Page> pages() { return List.copyOf(pages.values()); }
    private static String hash(byte[] value) throws Exception { return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(value)); }
}
