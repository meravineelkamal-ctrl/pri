const express = require("express");
const { cert, getApps, initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { FieldValue, getFirestore } = require("firebase-admin/firestore");

const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
const tranzupiToken = process.env.TRANZUPI_USER_TOKEN;
if (!serviceAccountJson) {
  throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_JSON environment variable");
}
if (!tranzupiToken) {
  throw new Error("Missing TRANZUPI_USER_TOKEN environment variable");
}

let serviceAccount;
try {
  serviceAccount = JSON.parse(serviceAccountJson);
} catch (error) {
  throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON must contain valid service-account JSON");
}

if (getApps().length === 0) {
  initializeApp({ credential: cert(serviceAccount) });
}

const db = getFirestore();
const app = express();
app.disable("x-powered-by");
app.use(express.urlencoded({ extended: false, limit: "10kb" }));
app.use(express.json({ limit: "10kb" }));

const defaultWebsiteOrigin = "https://winter-heart-fab3.meravineelkamal.workers.dev";
const configuredWebsiteOrigins = (process.env.WEBSITE_ORIGIN || defaultWebsiteOrigin)
  .split(",")
  .map(origin => origin.trim())
  .filter(Boolean)
  .map(origin => new URL(origin).origin);
const allowedWebsiteOrigins = new Set([defaultWebsiteOrigin, ...configuredWebsiteOrigins]);
const websiteOrigin = configuredWebsiteOrigins[0] || defaultWebsiteOrigin;
app.use((req, res, next) => {
  const origin = req.get("origin");
  if (origin && !allowedWebsiteOrigins.has(origin)) {
    res.status(403).json({ error: "Origin not allowed" });
    return;
  }
  if (origin) {
    res.setHeader("Access-Control-Allow-Origin", origin);
    res.setHeader("Vary", "Origin");
    res.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type");
    res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  }
  if (req.method === "OPTIONS") {
    res.sendStatus(204);
    return;
  }
  next();
});

async function verifyUser(req, res) {
  const authorization = req.get("authorization") || "";
  const match = authorization.match(/^Bearer (.+)$/i);
  if (!match) {
    res.status(401).json({ error: "Sign-in required" });
    return null;
  }
  try {
    return await getAuth().verifyIdToken(match[1]);
  } catch (error) {
    res.status(401).json({ error: "Invalid or expired sign-in" });
    return null;
  }
}

app.get("/health", (req, res) => {
  res.status(200).json({ status: "ok" });
});

app.post("/api/create-order", async (req, res) => {
  const user = await verifyUser(req, res);
  if (!user) return;

  const rawBookIds = req.body?.bookIds;
  if (!Array.isArray(rawBookIds) || rawBookIds.length < 1 || rawBookIds.length > 10
    || rawBookIds.some(id => typeof id !== "string" || !id || id.includes("/") || id.length > 128)
    || new Set(rawBookIds).size !== rawBookIds.length) {
    res.status(400).json({ error: "Select between 1 and 10 valid books" });
    return;
  }

  try {
    const bookSnapshots = await Promise.all(rawBookIds.map(id => db.collection("books").doc(id).get()));
    const fileSnapshots = await Promise.all(rawBookIds.map(id => db.collection("bookFiles").doc(id).get()));
    if (bookSnapshots.some(snapshot => !snapshot.exists) || fileSnapshots.some(snapshot => !snapshot.exists)) {
      res.status(400).json({ error: "One or more selected books are unavailable" });
      return;
    }

    const amount = bookSnapshots.reduce((total, snapshot) => {
      const price = Number(snapshot.data().price);
      if (!Number.isFinite(price) || price <= 0) throw new Error("INVALID_BOOK_PRICE");
      return total + price;
    }, 0);
    const roundedAmount = Math.round(amount * 100) / 100;
    const orderId = `KK-${require("node:crypto").randomUUID()}`;
    const orderRef = db.collection("orders").doc(orderId);
    await orderRef.create({
      uid: user.uid,
      bookIds: rawBookIds,
      amount: roundedAmount,
      status: "pending",
      createdAt: FieldValue.serverTimestamp()
    });

    try {
      const redirectOrigin = req.get("origin") || websiteOrigin;
      const redirectUrl = new URL("/", redirectOrigin);
      redirectUrl.searchParams.set("payment_return", "1");
      redirectUrl.searchParams.set("order_id", orderId);
      const parameters = new URLSearchParams({
        user_token: tranzupiToken,
        amount: roundedAmount.toFixed(2),
        order_id: orderId,
        redirect_url: redirectUrl.toString(),
        remark1: "KitabKosh digital book purchase"
      });
      if (typeof user.phone_number === "string" && /^[+\d -]{7,20}$/.test(user.phone_number)) {
        parameters.set("customer_mobile", user.phone_number.slice(0, 20));
      }

      const providerResponse = await fetch("https://tranzupi.com/api/create-order", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: parameters,
        signal: AbortSignal.timeout(15000)
      });
      if (!providerResponse.ok) {
        throw new Error(`TRANZUPI_HTTP_${providerResponse.status}`);
      }
      const providerResult = await providerResponse.json();
      const paymentUrl = providerResult?.result?.payment_url;
      let parsedPaymentUrl;
      try {
        parsedPaymentUrl = new URL(paymentUrl);
      } catch (error) {
        throw new Error("INVALID_PAYMENT_URL");
      }
      if (providerResult.status !== true
        || parsedPaymentUrl.protocol !== "https:"
        || !(parsedPaymentUrl.hostname === "tranzupi.com" || parsedPaymentUrl.hostname.endsWith(".tranzupi.com"))) {
        throw new Error("TRANZUPI_ORDER_REJECTED");
      }

      await orderRef.update({
        paymentUrl: parsedPaymentUrl.toString(),
        providerOrderId: String(providerResult.result.orderId || orderId).slice(0, 100),
        providerTxnRemark: String(providerResult.result.txn_remark || "").slice(0, 255),
        updatedAt: FieldValue.serverTimestamp()
      });
      res.status(201).json({
        orderId,
        amount: roundedAmount,
        paymentUrl: parsedPaymentUrl.toString()
      });
    } catch (error) {
      await orderRef.update({
        status: "create_failed",
        failureReason: error.message.slice(0, 120),
        updatedAt: FieldValue.serverTimestamp()
      });
      throw error;
    }
  } catch (error) {
    if (error.message === "INVALID_BOOK_PRICE") {
      res.status(400).json({ error: "A selected book has an invalid price" });
      return;
    }
    console.error("TranzUPI order creation failed:", error.message);
    res.status(502).json({ error: "Could not start payment. Please try again or contact support." });
  }
});

app.get("/api/order-status/:orderId", async (req, res) => {
  const user = await verifyUser(req, res);
  if (!user) return;
  const orderId = req.params.orderId;
  if (!/^KK-[\w-]{1,100}$/.test(orderId)) {
    res.status(400).json({ error: "Invalid order ID" });
    return;
  }
  try {
    const snapshot = await db.collection("orders").doc(orderId).get();
    if (!snapshot.exists || snapshot.data().uid !== user.uid) {
      res.status(404).json({ error: "Order not found" });
      return;
    }
    res.status(200).json({ status: snapshot.data().status });
  } catch (error) {
    console.error("Could not check order status:", error.message);
    res.status(500).json({ error: "Could not check payment status" });
  }
});

app.post("/api/webhook", async (req, res) => {
  const orderId = String(req.body?.order_id || "").trim();
  const callbackAmount = Number(req.body?.amount);
  if (!orderId || orderId.length > 128 || orderId.includes("/")
    || !Number.isFinite(callbackAmount) || callbackAmount <= 0) {
    res.status(400).send("Invalid order_id or amount");
    return;
  }

  try {
    const verifyResponse = await fetch("https://tranzupi.com/api/check-order-status", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        user_token: tranzupiToken,
        order_id: orderId
      }),
      signal: AbortSignal.timeout(10000)
    });

    if (!verifyResponse.ok) {
      console.error("TranzUPI verification HTTP status:", verifyResponse.status);
      res.status(502).send("Payment verification unavailable");
      return;
    }

    const verification = await verifyResponse.json();
    const verifiedStatus = String(verification?.result?.status || "").toUpperCase();
    const verifiedAmount = Number(verification?.result?.amount);
    if (verifiedStatus !== "SUCCESS" || !Number.isFinite(verifiedAmount)) {
      res.status(202).send("Payment not confirmed");
      return;
    }
    if (Math.abs(verifiedAmount - callbackAmount) > 0.01) {
      res.status(400).send("Amount mismatch");
      return;
    }

    const orderRef = db.collection("orders").doc(orderId);
    await db.runTransaction(async transaction => {
      const orderSnapshot = await transaction.get(orderRef);
      if (!orderSnapshot.exists) throw new Error("ORDER_NOT_FOUND");

      const order = orderSnapshot.data();
      if (order.status === "paid") return;
      const bookIds = Array.isArray(order.bookIds) ? order.bookIds : [order.bookId];
      if (order.status !== "pending"
        || typeof order.uid !== "string"
        || bookIds.length < 1
        || bookIds.length > 10
        || bookIds.some(bookId => typeof bookId !== "string" || !bookId || bookId.includes("/"))
        || !Number.isFinite(Number(order.amount))
        || Math.abs(Number(order.amount) - verifiedAmount) > 0.01) {
        throw new Error("ORDER_MISMATCH");
      }

      const bookAndFileSnapshots = await Promise.all(bookIds.flatMap(bookId => [
        transaction.get(db.collection("books").doc(bookId)),
        transaction.get(db.collection("bookFiles").doc(bookId))
      ]));
      if (bookAndFileSnapshots.some(snapshot => !snapshot.exists)) throw new Error("BOOK_UNAVAILABLE");

      transaction.update(orderRef, {
        status: "paid",
        paidAt: FieldValue.serverTimestamp(),
        utr: String(req.body?.utr || "").slice(0, 64)
      });
      bookIds.forEach(bookId => {
        const purchaseRef = db.collection("users").doc(order.uid)
          .collection("purchases").doc(bookId);
        transaction.set(purchaseRef, {
          bookId,
          orderId,
          amount: verifiedAmount,
          purchasedAt: FieldValue.serverTimestamp()
        });
      });
    });

    res.status(200).send("OK");
  } catch (error) {
    if (["ORDER_NOT_FOUND", "ORDER_MISMATCH", "BOOK_UNAVAILABLE"].includes(error.message)) {
      console.error("Verified payment could not be matched to a pending order:", error.message);
      res.status(409).send("Order not ready for fulfillment");
      return;
    }
    console.error("TranzUPI webhook processing failed:", error.message);
    res.status(500).send("Webhook processing failed");
  }
});

const port = Number(process.env.PORT) || 10000;
app.listen(port, "0.0.0.0", () => {
  console.log(`Webhook server listening on port ${port}`);
});
