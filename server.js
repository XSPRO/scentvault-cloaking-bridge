const express = require('express');
const fetch = require('node-fetch');

if (!global.fetch) {
  global.fetch = fetch;
}

const app = express();
app.use(express.urlencoded({ extended: true }));
app.use(express.json());

// Store config
const STORE_DOMAIN = 'd1uaxf-xh.myshopify.com';
const STOREFRONT_TOKEN = 'f40c693b0aaf0d17799b8738307332d6';
const STOREFRONT_API = `https://${STORE_DOMAIN}/api/2025-01/graphql.json`;
const DISCORD_WEBHOOK = 'https://discord.com/api/webhooks/1462766339734245450/tvQamu299eAdNOGw3jEWI97J0g4nAEvJVaXTLcJifK_v86Z0lgSu2mEJ1vJtCI9J-t0k';
const STORE_A_CART_URL = 'https://scentvault.shop/cart';

// In-memory SKU map: { "XVA": { variantId: "gid://...", productTitle: "..." }, ... }
let skuMap = {};

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'POST, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(200);
  next();
});

// GraphQL helper
async function storefrontQuery(query, variables = {}) {
  const res = await fetch(STOREFRONT_API, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Shopify-Storefront-Access-Token': STOREFRONT_TOKEN,
    },
    body: JSON.stringify({ query, variables }),
  });
  return res.json();
}

// Fetch ALL products from Store B and build SKU map
async function buildSkuMap() {
  const map = {};
  let hasNextPage = true;
  let cursor = null;

  while (hasNextPage) {
    const afterClause = cursor ? `, after: "${cursor}"` : '';
    const query = `
      {
        products(first: 50${afterClause}) {
          edges {
            node {
              title
              variants(first: 50) {
                edges {
                  node {
                    id
                    sku
                  }
                }
              }
            }
            cursor
          }
          pageInfo {
            hasNextPage
          }
        }
      }
    `;

    const data = await storefrontQuery(query);

    if (!data.data || !data.data.products) break;

    for (const edge of data.data.products.edges) {
      const product = edge.node;
      for (const variantEdge of product.variants.edges) {
        const variant = variantEdge.node;
        if (variant.sku && variant.sku.trim() !== '') {
          map[variant.sku] = {
            variantId: variant.id,
            productTitle: product.title,
          };
        }
      }
      cursor = edge.cursor;
    }

    hasNextPage = data.data.products.pageInfo.hasNextPage;
  }

  skuMap = map;
  console.log(`SKU map built: ${Object.keys(skuMap).length} products mapped`);
}

// Create a cart on Store B
async function createCart(lineItems) {
  const query = `
    mutation cartCreate($input: CartInput!) {
      cartCreate(input: $input) {
        cart {
          id
          checkoutUrl
        }
        userErrors {
          field
          message
        }
      }
    }
  `;

  const variables = {
    input: {
      lines: lineItems.map(item => {
        const line = {
          merchandiseId: item.variantId,
          quantity: item.quantity,
        };
        if (item.attributes && item.attributes.length > 0) {
          line.attributes = item.attributes;
        }
        return line;
      }),
    },
  };

  return await storefrontQuery(query, variables);
}

// Discord notification
function notifyDiscord(matchedItems) {
  const productList = matchedItems
    .map(i => `${i.productTitle} (x${i.quantity})`)
    .join('\n');

  fetch(DISCORD_WEBHOOK, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      content: '🛒 **Checkout Started**\nItems: ' + matchedItems.length + '\n\n' + productList,
    }),
  }).catch(() => {});
}

// Main bridge endpoint
app.post('/checkout-bridge', async (req, res) => {
  try {
    let items;
    if (typeof req.body.items === 'string') {
      items = JSON.parse(req.body.items);
    } else {
      items = req.body.items;
    }

    if (!items || items.length === 0) {
      return res.redirect(302, STORE_A_CART_URL);
    }

    // Look up each SKU from our pre-built map
    const lineItems = [];
    const matchedItems = [];

    for (const item of items) {
      const match = skuMap[item.sku];
      if (match) {
        const lineItem = { variantId: match.variantId, quantity: item.quantity };

        if (item.properties && Array.isArray(item.properties) && item.properties.length > 0) {
          lineItem.attributes = item.properties;
        }

        lineItems.push(lineItem);
        matchedItems.push({ productTitle: match.productTitle, quantity: item.quantity });
      }
    }

    if (lineItems.length === 0) {
      return res.redirect(302, STORE_A_CART_URL);
    }

    // Create cart on Store B
    const cartData = await createCart(lineItems);

    if (cartData.data?.cartCreate?.cart?.checkoutUrl) {
      const checkoutUrl = cartData.data.cartCreate.cart.checkoutUrl;
      console.log('CHECKOUT URL:', checkoutUrl);

      setImmediate(() => notifyDiscord(matchedItems));

      res.set({
        'Referrer-Policy': 'no-referrer',
        'Cache-Control': 'no-cache, no-store, must-revalidate',
      });

      return res.redirect(302, checkoutUrl);
    }

    return res.redirect(302, STORE_A_CART_URL);
  } catch (err) {
    return res.redirect(302, STORE_A_CART_URL);
  }
});

// Debug endpoint
app.get('/debug/:sku', (req, res) => {
  const sku = req.params.sku;
  const match = skuMap[sku];
  res.json({
    sku: sku,
    found: !!match,
    match: match || null,
    totalMapped: Object.keys(skuMap).length,
  });
});

// Force refresh the SKU map
app.get('/refresh', async (req, res) => {
  await buildSkuMap();
  res.json({
    status: 'SKU map refreshed',
    totalMapped: Object.keys(skuMap).length,
    skus: Object.keys(skuMap),
  });
});

// Health check
app.get('/', (req, res) => {
  res.json({
    status: 'ScentVault Checkout Bridge is live',
    totalMapped: Object.keys(skuMap).length,
    timestamp: new Date().toISOString(),
  });
});

// Build SKU map on startup, then refresh every 10 minutes
buildSkuMap().then(() => {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => {
    console.log(`Bridge running on port ${PORT}`);
  });
});

setInterval(buildSkuMap, 10 * 60 * 1000);
app.post('/test-checkout', async (req, res) => {
  let items;
  if (typeof req.body.items === 'string') items = JSON.parse(req.body.items);
  else items = req.body.items;

  const lineItems = [];
  for (const item of items) {
    const match = skuMap[item.sku];
    if (match) lineItems.push({ variantId: match.variantId, quantity: item.quantity });
  }

  const cartData = await createCart(lineItems);
  res.json(cartData);
});
