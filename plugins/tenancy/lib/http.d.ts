import type { IncomingMessage, ServerResponse } from 'node:http';
import { type StudioIdentityService } from '@dz23-studio/identity';
import { StudioTenancyService } from './service.js';
/**
 * O que cada rota declara — e ONDE a permissão é de fato conferida.
 *
 * O campo `permission` é DOCUMENTO, e não porta. A porta é o serviço, em
 * `#authorize(actor, workspaceId, permission)`, e tem de ser lá por uma razão
 * de modelo: papel neste produto é POR ESPAÇO DE TRABALHO, não por pessoa.
 * A mesma pessoa é dona de um espaço e leitora de outro, e a rota não sabe de
 * qual espaço se trata antes de ler o corpo (`/invitations`) ou de resolver a
 * matrícula (`/memberships/:membershipId`) — e em `/workspaces` não há espaço
 * nenhum, porque a resposta é justamente a lista deles.
 *
 * Isto está escrito porque havia uma função `authorizeRoute(role, permission)`
 * aqui, exportada, testada e NUNCA chamada em produção: uma revisão adversarial
 * apontou, com razão, que ela era código de autorização morto. Ela foi
 * REMOVIDA em vez de ligada — ligá-la exigiria um papel por pessoa, que este
 * produto não tem, e produziria uma conferência contra o papel errado. Função
 * de autorização que não roda é pior que nenhuma: ela faz quem lê o arquivo
 * acreditar que a rota confere algo que só o serviço confere.
 */
export declare const TENANCY_ROUTE_CONTRACTS: readonly [{
    readonly method: "GET";
    readonly path: "/workspaces";
    readonly access: "authorized";
    readonly permission: "workspace.read";
    readonly scope: "org";
}, {
    readonly method: "POST";
    readonly path: "/workspaces";
    readonly access: "authorized";
    readonly permission: "workspace.create";
    readonly scope: "org";
}, {
    readonly method: "GET";
    readonly path: "/workspaces/:workspaceId/members";
    readonly access: "authorized";
    readonly permission: "members.read";
    readonly scope: "workspace";
}, {
    readonly method: "POST";
    readonly path: "/invitations";
    readonly access: "authorized";
    readonly permission: "members.manage";
    readonly scope: "workspace";
}, {
    readonly method: "POST";
    readonly path: "/invitations/accept";
    readonly access: "authenticated";
    readonly permission: null;
    readonly scope: "invitation";
}, {
    readonly method: "PATCH";
    readonly path: "/memberships/:membershipId";
    readonly access: "authorized";
    readonly permission: "members.manage";
    readonly scope: "workspace";
}];
export interface TenancyHttpConfig {
    readonly service: StudioTenancyService;
    readonly identity: StudioIdentityService;
    readonly allowedHosts: readonly string[];
    readonly allowedOrigins: readonly string[];
}
export declare function createTenancyHttpHandler(config: TenancyHttpConfig): (request: IncomingMessage, response: ServerResponse) => Promise<void>;
//# sourceMappingURL=http.d.ts.map