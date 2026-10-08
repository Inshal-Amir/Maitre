import type { OAuthClientProvider } from '@modelcontextprotocol/sdk/client/auth.js';
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from '@modelcontextprotocol/sdk/shared/auth.js';
import type { LoopbackListener } from './loopback';
import { readSecret, writeSecret } from '../settings';
import { listenForRedirect } from './loopback';

/** Fixed so the redirect registered with the server (dynamic client registration) stays valid across runs. */
export const MCP_REDIRECT_PORT = Number(process.env.MAITRE_MCP_REDIRECT_PORT ?? 33418);
const REDIRECT_PATH = '/mcp/callback';

interface Stored {
  client?: OAuthClientInformationMixed;
  tokens?: OAuthTokens;
  verifier?: string;
}

/** OAuth for remote MCP servers (MCP authorization spec): discovery and registration by the SDK, sign-in in the browser. */
export class OAuthProvider implements OAuthClientProvider {
  private listener: LoopbackListener | null = null;

  constructor(private readonly serverId: string, private readonly openBrowser: (url: string) => Promise<void>) {}

  get redirectUrl(): string {
    return `http://127.0.0.1:${MCP_REDIRECT_PORT}${REDIRECT_PATH}`;
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: 'Maitre Desktop',
      redirect_uris: [this.redirectUrl],
      grant_types: ['authorization_code', 'refresh_token'],
      response_types: ['code'],
      token_endpoint_auth_method: 'none',
    };
  }

  private read(): Stored {
    try {
      return JSON.parse(readSecret(`mcp-${this.serverId}`) ?? '{}') as Stored;
    } catch {
      return {};
    }
  }

  private write(patch: Stored): void {
    writeSecret(`mcp-${this.serverId}`, JSON.stringify({ ...this.read(), ...patch }));
  }

  clientInformation(): OAuthClientInformationMixed | undefined {
    return this.read().client;
  }

  saveClientInformation(client: OAuthClientInformationMixed): void {
    this.write({ client });
  }

  tokens(): OAuthTokens | undefined {
    return this.read().tokens;
  }

  saveTokens(tokens: OAuthTokens): void {
    this.write({ tokens });
  }

  saveCodeVerifier(verifier: string): void {
    this.write({ verifier });
  }

  codeVerifier(): string {
    const verifier = this.read().verifier;
    if (!verifier) throw new Error('No PKCE verifier saved for this sign-in.');
    return verifier;
  }

  async redirectToAuthorization(url: URL): Promise<void> {
    this.listener?.close();
    this.listener = await listenForRedirect(MCP_REDIRECT_PORT, REDIRECT_PATH);
    await this.openBrowser(url.toString());
  }

  async waitForCode(): Promise<string> {
    if (!this.listener) throw new Error('The server asked for sign-in but no browser sign-in was started.');
    try {
      return (await this.listener.result).code;
    } finally {
      this.listener.close();
      this.listener = null;
    }
  }

  forget(): void {
    writeSecret(`mcp-${this.serverId}`, '');
  }
}
