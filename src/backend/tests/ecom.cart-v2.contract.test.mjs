import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import { mocks } from "./loader.mjs";
import {
  createCartElevated,
  getCartCheckoutUrlElevated,
  _extractCartId,
} from "../booking/bookingCore.js";

const ECOM_CART_MOCK_KEY = "@wix/ecom::cartV2";
const CART_ID = "2f0f8f4d-2d8c-4b1f-9c51-1c89cdb5d102";

test("ECOM-CART-V2-01 booking payment uses Cart V2 SDK and returns a checkout URL", async () => {
  const calls = [];
  mocks.sdk[ECOM_CART_MOCK_KEY] = {
    createCart: async (options) => {
      calls.push({ method: "createCart", options });
      return { _id: CART_ID };
    },
    getCheckoutUrl: async (cartId) => {
      calls.push({ method: "getCheckoutUrl", cartId });
      return { checkoutUrl: "https://checkout.wix.com/cart/" + cartId };
    },
  };

  try {
    const options = {
      catalogItems: [{
        catalogReference: {
          appId: "13d21c63-b5ec-5912-8397-c3a5ddb27a97",
          catalogItemId: "3c87c3b4-22d1-4a16-8b75-18ecf8241c72",
          options: {},
        },
        quantity: 1,
      }],
      cart: { source: { channelType: "WEB" } },
    };

    const cart = await createCartElevated(options);
    const cartId = _extractCartId(cart);
    const checkout = await getCartCheckoutUrlElevated(cartId);

    assert.equal(cartId, CART_ID);
    assert.equal(checkout.checkoutUrl, "https://checkout.wix.com/cart/" + CART_ID);
    assert.deepEqual(calls, [
      { method: "createCart", options },
      { method: "getCheckoutUrl", cartId: CART_ID },
    ]);
  } finally {
    delete mocks.sdk[ECOM_CART_MOCK_KEY];
  }
});

test("ECOM-CART-V2-02 saga maps booking reference to catalogItems and removes Checkout V1 calls", () => {
  const sagaPath = fileURLToPath(new URL("../booking/bookingSaga.js", import.meta.url));
  const source = readFileSync(sagaPath, "utf8");

  assert.match(source, /catalogItems:\s*\[/);
  assert.match(source, /catalogItemId:\s*bookingF1Id/);
  assert.match(source, /cart:\s*\{\s*source:\s*\{\s*channelType:\s*"WEB"/);
  assert.match(source, /createCartElevated\(cartPayload\)/);
  assert.match(source, /getCartCheckoutUrlElevated\(cartId\)/);
  assert.match(source, /checkoutUrlResponse\s*&&\s*checkoutUrlResponse\.checkoutUrl/);
  assert.doesNotMatch(source, /createCheckoutElevated|checkout\.createCheckout|getCheckoutUrlElevated/);
});
