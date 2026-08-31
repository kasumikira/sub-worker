import { DOStorageAdapter } from './storage';
import {
    attachPersistentStore,
    runWithLegacyGlobals,
} from './legacy-globals';
import { registerQuickJSRuntime } from './quickjs-runtime';

registerQuickJSRuntime();

const DURABLE_OBJECT_NAME = 'default';
const PUBLIC_API_PATH = /^\/(api\/(download|preview|sub\/flow)|download|share)(\/|$)/;

function unauthorized(message = 'Unauthorized') {
    return new Response(JSON.stringify({ status: 'failed', message }), {
        status: 401,
        headers: {
            'content-type': 'application/json;charset=UTF-8',
            'cache-control': 'no-store',
        },
    });
}

function authorizeRequest(request, env) {
    const url = new URL(request.url);
    const backendPath = env.SUB_STORE_FRONTEND_BACKEND_PATH;
    const hasValidBackendPath =
        backendPath?.startsWith('/') && !backendPath.endsWith('/');

    if (hasValidBackendPath) {
        if (url.pathname === backendPath) {
            url.pathname = `${backendPath}/`;
            return Response.redirect(url.toString(), 302);
        }
        if (url.pathname.startsWith(`${backendPath}/`)) {
            url.pathname = url.pathname.slice(backendPath.length) || '/';
            return new Request(url.toString(), request);
        }
    }

    const isPublic = PUBLIC_API_PATH.test(url.pathname);
    const isManagementApi =
        url.pathname === '/api' || url.pathname.startsWith('/api/');

    if (isPublic || !isManagementApi) return request;
    if (!backendPath) {
        return unauthorized('Management API authentication is not configured');
    }
    if (!hasValidBackendPath) {
        return unauthorized('Invalid management API authentication configuration');
    }
    return unauthorized();
}

export class SubStoreDO {
    constructor(ctx, env) {
        this.storage = new DOStorageAdapter(ctx.storage);
        this.requestQueue = Promise.resolve();
        this.ready = ctx.blockConcurrencyWhile(async () => {
            const { default: $ } = await import('@/core/app');
            attachPersistentStore(this.storage, $);

            const [{ default: migrate }, { default: serve }] =
                await Promise.all([
                    import('@/utils/migration'),
                    import('@/restful'),
                ]);
            migrate();
            this.app = serve();
        });
    }

    fetch(request) {
        const run = () => this.handleRequest(request);
        const response = this.requestQueue.then(run, run);
        this.requestQueue = response.then(
            () => undefined,
            () => undefined,
        );
        return response;
    }

    async handleRequest(request) {
        await this.ready;
        const headers = Object.fromEntries(request.headers);
        const legacyRequest = {
            method: request.method,
            url: request.url,
            headers,
            body: ['GET', 'HEAD'].includes(request.method)
                ? undefined
                : await request.text(),
        };
        const response = await runWithLegacyGlobals(
            legacyRequest,
            this.storage,
            () => this.app.start(),
        );
        return new Response(response.body, {
            status:
                typeof response.status === 'number'
                    ? response.status
                    : response.statusCode || 200,
            headers: response.headers,
        });
    }
}

export default {
    async fetch(request, env) {
        const authorized = authorizeRequest(request, env);
        if (authorized instanceof Response) return authorized;
        try {
            return await env.SUB_STORE.getByName(DURABLE_OBJECT_NAME).fetch(
                authorized,
            );
        } catch (error) {
            console.error('[Cloudflare] Durable Object request failed', error);
            throw error;
        }
    },
};
