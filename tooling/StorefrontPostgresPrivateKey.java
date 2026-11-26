import java.io.InputStream;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.KeyStore;
import java.security.PrivateKey;
import java.util.Arrays;
import java.util.Base64;

class StorefrontPostgresPrivateKey {
    public static void main(String[] args) throws Exception {
        char[] password = System.getenv("CRUSTCAPER_FIXTURE_TLS_KEY_PASSWORD").toCharArray();
        try (InputStream input = Files.newInputStream(Path.of(args[0]))) {
            KeyStore keys = KeyStore.getInstance("PKCS12");
            keys.load(input, password);
            PrivateKey key = (PrivateKey) keys.getKey("postgres", password);
            String encoded = Base64.getMimeEncoder(64, new byte[] {'\n'}).encodeToString(key.getEncoded());
            System.out.println("-----BEGIN PRIVATE KEY-----\n" + encoded + "\n-----END PRIVATE KEY-----");
        } finally {
            Arrays.fill(password, '\0');
        }
    }
}
