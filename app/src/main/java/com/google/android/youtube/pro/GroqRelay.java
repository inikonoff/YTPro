package com.google.android.youtube.pro;

import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import javax.net.ssl.HttpsURLConnection;

import org.json.JSONArray;
import org.json.JSONException;
import org.json.JSONObject;

public final class GroqRelay {
    private static final String ENDPOINT = "https://voicebot-iwdm.onrender.com/api/link/chat";
    public static final String MODEL = "openai/gpt-oss-20b";

    private GroqRelay() {}

    public static String chat(String key, JSONArray messages, int maxTokens) throws IOException, JSONException {
        JSONObject request = new JSONObject()
                .put("provider", "groq")
                .put("api_key", key)
                .put("messages", messages)
                .put("max_tokens", maxTokens)
                .put("model", MODEL);
        HttpsURLConnection connection = (HttpsURLConnection) new URL(ENDPOINT).openConnection();
        try {
            connection.setConnectTimeout(20000);
            connection.setReadTimeout(90000);
            connection.setInstanceFollowRedirects(false);
            connection.setRequestMethod("POST");
            connection.setRequestProperty("Content-Type", "application/json; charset=UTF-8");
            connection.setDoOutput(true);

            byte[] body = request.toString().getBytes(StandardCharsets.UTF_8);
            connection.setFixedLengthStreamingMode(body.length);
            try (OutputStream output = connection.getOutputStream()) {
                output.write(body);
            }

            int status = connection.getResponseCode();
            if (status == 401 || status == 403) throw new IOException("Groq отклонил API-ключ или доступ к модели.");
            if (status == 429) throw new IOException("Превышен лимит запросов Groq. Попробуйте позже.");
            if (status < 200 || status >= 300) throw new IOException("Ошибка relay (HTTP " + status + ").");

            JSONObject response;
            try (InputStream input = connection.getInputStream();
                 ByteArrayOutputStream output = new ByteArrayOutputStream()) {
                byte[] buffer = new byte[4096];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
                response = new JSONObject(output.toString("UTF-8"));
            }
            if (!"success".equals(response.optString("status"))) {
                String error = response.optString("error", "Groq не выполнил запрос.");
                throw new IOException(error.replace(key, "[ключ скрыт]"));
            }
            String model = response.optString("model");
            if (!model.isEmpty() && !MODEL.equals(model)) {
                throw new IOException("Relay вернул ответ от другой модели.");
            }
            String content = response.optString("content").trim();
            if (response.isNull("content") || content.isEmpty()) throw new IOException("Groq вернул пустой ответ.");
            return content;
        } finally {
            connection.disconnect();
        }
    }
}
