/** Narrow v0.30.0 host compatibility for Pi 0.85.1's public ModelRuntime API.
 * No Agent loop, tools, session storage or lifecycle is reimplemented here.
 * Internal host supports runtime API keys; upstream OAuth/providerEnv mode is not enabled.
 */
import {
  createAgentSession as createPiAgentSession,
  ModelRegistry as PiModelRegistry,
  ModelRuntime,
  type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";

export * from "@earendil-works/pi-coding-agent";

const runtime = await ModelRuntime.create({
  credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
  modelsPath: null, allowModelNetwork: false,
});

export class AuthStorage {
  readonly runtime = runtime;
  private readonly pending: Promise<void>[] = [];
  static create(): AuthStorage { return new AuthStorage(); }
  static inMemory(): never { throw new Error("linkcode_provider_env_credentials_not_enabled"); }
  setRuntimeApiKey(provider: string, key: string): void {
    this.pending.push(this.runtime.setRuntimeApiKey(provider, key));
  }
  async ready(): Promise<void> { await Promise.all(this.pending); }
}

export class ModelRegistry extends PiModelRegistry {
  static create(auth: AuthStorage): ModelRegistry { return new ModelRegistry(auth.runtime); }
}

export async function createAgentSession(options: CreateAgentSessionOptions & {
  authStorage: AuthStorage; modelRegistry: ModelRegistry;
}) {
  const { authStorage, modelRegistry: _registry, ...sessionOptions } = options;
  await authStorage.ready();
  return createPiAgentSession({ ...sessionOptions, modelRuntime: authStorage.runtime });
}
