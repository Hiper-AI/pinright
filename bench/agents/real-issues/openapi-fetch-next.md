### Description

[Per the docs](https://nextjs.org/docs/app/building-your-application/data-fetching/fetching#reusing-data-across-multiple-functions), since v15 Next has changed the default caching strategy on fetch requests. Now, fetch requests are uncached by default so `cache: 'force-cache'` must be added. This can be done during `createClient` instantiation.

Moreover, Nextjs is not including `openapi-fetch` requests in the patched lifecycle so regardless of setting the above, `openapi-fetch` requests will always be uncached in Next. This can be verified by enable [fetch logging](https://nextjs.org/docs/app/api-reference/config/next-config-js/logging#fetching).

Due to the nature of the lifecycle fetch request patching in Next, one can simply not pass in global fetch during createClient instantiation as follows:

```
export const client = createClient<paths>({
  baseUrl: '',
  fetch,
})
```
This will not work as expected because the Nextjs fetch patching has not yet occurred at this point.

### Proposal

I propose to update the docs and Nextjs example to show an alternative approach that is both clean and reusable and ensures that the patched `fetch` method and cache controls do not need to be passed with every API client request as this is error prone and verbose. Instead, a simple config like the following works as expected and enables caching by default. Moreover, I would recommend to note in the docs that individual requests can override the caching behavior on a per-request basis.

```
export const client = createClient<paths>({
  baseUrl: '',
  cache: 'force-cache', // Add cache by default
  // This is needed to inject Next's patched native fetch during the request lifecycle
  fetch: (input) => fetch(input),
})
```

and per request override:

```
const res = await client.GET('/users', {
  cache: 'no-cache',
})
```
