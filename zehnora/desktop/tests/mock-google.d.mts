export interface MockGoogleRequest { route: string; query: Record<string, string>; body: string; auth?: string }
export interface MockGoogle { url: string; log: MockGoogleRequest[]; tokens: { current: string }; close(): Promise<void> }
export function startMockGoogle(port: number): Promise<MockGoogle>;
