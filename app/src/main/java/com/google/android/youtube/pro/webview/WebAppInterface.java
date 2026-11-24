package com.google.android.youtube.pro.webview;

import android.app.AlertDialog;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.Intent;
import android.content.SharedPreferences;
import android.content.res.Configuration;
import android.graphics.Typeface;
import android.graphics.drawable.ColorDrawable;
import android.graphics.drawable.GradientDrawable;
import android.content.pm.PackageInfo;
import android.content.pm.PackageManager;
import android.media.AudioManager;
import android.net.Uri;
import android.provider.Settings;
import android.text.InputType;
import android.util.Rational;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.view.View;
import android.widget.Button;
import android.widget.EditText;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.TextView;
import android.widget.Toast;
import java.io.File;
import android.Manifest;

import android.os.Build;
import android.os.Environment;
import androidx.webkit.WebViewFeature;

import com.google.android.youtube.pro.ForegroundService;
import com.google.android.youtube.pro.GroqRelay;
import com.google.android.youtube.pro.MainActivity;
import com.google.android.youtube.pro.R;
import com.google.android.youtube.pro.utils.DownloadUtils;
import com.google.android.youtube.pro.utils.MediaMuxerUtils;

import org.json.JSONArray;
import org.json.JSONObject;

public class WebAppInterface {
	private final MainActivity activity;
	private final YTProWebView web;
	private final AudioManager audioManager;
	
	private String icon = "";
	private String title = "";
	private String subtitle = "";
	private long duration;
	
	public WebAppInterface(MainActivity activity, YTProWebView web) {
		this.activity = activity;
		this.web = web;
		this.audioManager = (AudioManager) activity.getSystemService(Context.AUDIO_SERVICE);
	}
	
	@JavascriptInterface
	public void showToast(String txt) {
		Toast.makeText(activity.getApplicationContext(), txt, Toast.LENGTH_SHORT).show();
	}
	
	@JavascriptInterface
	public void gohome(String x) {
		Intent startMain = new Intent(Intent.ACTION_MAIN);
		startMain.addCategory(Intent.CATEGORY_HOME);
		startMain.setFlags(Intent.FLAG_ACTIVITY_NEW_TASK);
		activity.startActivity(startMain);
	}
	
	@JavascriptInterface
	public void saveCaptionText(String filename, String text) {
		activity.runOnUiThread(() -> activity.saveCaptionText(filename, text));
	}

	@JavascriptInterface
	public void downvid(String name, String url, String m) {
		DownloadUtils.downloadFile(activity, name, url, m);
	}
	
	@JavascriptInterface
	public void fullScreen(boolean value) {
		activity.portrait = value;
	}
	
	@JavascriptInterface
	public void oplink(String url) {
		Intent i = new Intent(Intent.ACTION_VIEW);
		i.setData(Uri.parse(url));
		activity.startActivity(i);
	}
	
	@JavascriptInterface
	public String getInfo() {
		try {
			PackageInfo info = activity.getPackageManager().getPackageInfo(activity.getPackageName(), PackageManager.GET_ACTIVITIES);
			return info.versionName;
		} catch (Exception e) {
			return "1.0";
		}
	}
	@JavascriptInterface
	public boolean isWebViewSupported() {
		return WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_ARRAY_BUFFER);
	}
	
	@JavascriptInterface
	public boolean hasStoragePermission() {
		if (Build.VERSION.SDK_INT > 22 && Build.VERSION.SDK_INT < Build.VERSION_CODES.R){
			if (activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_DENIED || activity.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_DENIED) {
				activity.runOnUiThread(() -> Toast.makeText(activity, R.string.grant_storage, Toast.LENGTH_SHORT).show());
				activity.requestPermissions(new String[]{Manifest.permission.WRITE_EXTERNAL_STORAGE,Manifest.permission.READ_EXTERNAL_STORAGE}, 1);
			}
			return (activity.checkSelfPermission(Manifest.permission.WRITE_EXTERNAL_STORAGE) == PackageManager.PERMISSION_DENIED || activity.checkSelfPermission(Manifest.permission.READ_EXTERNAL_STORAGE) == PackageManager.PERMISSION_DENIED);
		}
		return true;
	}
	
	@JavascriptInterface
	public void requestBinaryPort(String fileName) {
		activity.runOnUiThread(() -> {
			if (activity.streamManager != null) {
				activity.streamManager.openStreamForFile(fileName);
			}
		});
	}
	
	@JavascriptInterface
	public void muxVideoAudio(String videoFileName,String audioFileName,String outputFileName) {
		java.io.File downloads = Environment.getExternalStoragePublicDirectory(Environment.DIRECTORY_DOWNLOADS.concat("/YTPRO"));
		java.io.File video  = new java.io.File(downloads, videoFileName);
		java.io.File audio  = new java.io.File(downloads, audioFileName);
		
		java.io.File output = new java.io.File(downloads, outputFileName);
		
		MediaMuxerUtils.muxVideoAudio(activity.getApplicationContext(), video, audio, output, new MediaMuxerUtils.MuxCallback() {
			@Override
			public void onSuccess(File output) {
				// safe to update UI here — already on main thread
				Toast.makeText(activity, "Done: " + output.getName(), Toast.LENGTH_SHORT).show();
			}
			
			@Override
			public void onFailure(Exception e) {
				Toast.makeText(activity, "Failed: " + e.getMessage(), Toast.LENGTH_SHORT).show();
			}
		});
	}
	
	@JavascriptInterface
	public void setBgPlay(boolean bgplay) {
		activity.getSharedPreferences("YTPRO", Context.MODE_PRIVATE).edit().putBoolean("bgplay", bgplay).apply();
	}
	
	@JavascriptInterface
	public void bgStart(String iconn, String titlen, String subtitlen, long dura) {
		icon = iconn; title = titlen; subtitle = subtitlen; duration = dura;
		activity.mediaSession = true; activity.setPlaying(true);
		
		Intent intent = new Intent(activity.getApplicationContext(), ForegroundService.class);
		intent.putExtra("icon", icon); intent.putExtra("title", title);
		intent.putExtra("subtitle", subtitle); intent.putExtra("duration", duration);
		intent.putExtra("currentPosition", 0); intent.putExtra("action", "play");
		activity.startService(intent);
	}
	
	@JavascriptInterface
	public void bgUpdate(String iconn, String titlen, String subtitlen, long dura) {
		icon = iconn; title = titlen; subtitle = subtitlen; duration = dura;
		activity.setPlaying(true);
		sendUpdateBroadcast(0, "pause");
	}
	
	@JavascriptInterface
	public void bgStop() {
		activity.mediaSession = false; activity.setPlaying(false);
		activity.stopService(new Intent(activity.getApplicationContext(), ForegroundService.class));
	}
	
	@JavascriptInterface
	public void bgPause(long ct) {
		activity.setPlaying(false);
		sendUpdateBroadcast(ct, "pause");
	}
	
	@JavascriptInterface
	public void bgPlay(long ct) {
		activity.setPlaying(true);
		sendUpdateBroadcast(ct, "play");
	}
	
	@JavascriptInterface
	public void bgBuffer(long ct) {
		activity.setPlaying(true);
		sendUpdateBroadcast(ct, "buffer");
	}
	
	private void sendUpdateBroadcast(long ct, String action) {
		activity.sendBroadcast(new Intent("UPDATE_NOTIFICATION")
		.putExtra("icon", icon).putExtra("title", title)
		.putExtra("subtitle", subtitle).putExtra("duration", duration)
		.putExtra("currentPosition", ct).putExtra("action", action));
	}
	
	private SharedPreferences groqPreferences() {
		return activity.getSharedPreferences("groq", Context.MODE_PRIVATE);
	}

	@JavascriptInterface
	public boolean hasGroqKey() {
		return !groqPreferences().getString("apiKey", "").isEmpty();
	}

	private int dp(int size) {
		return Math.round(size * activity.getResources().getDisplayMetrics().density);
	}

	private GradientDrawable groqSurface(int color, int radius) {
		GradientDrawable surface = new GradientDrawable();
		surface.setColor(color);
		surface.setCornerRadius(dp(radius));
		return surface;
	}

	private TextView groqLabel(LinearLayout column, String value, int size, int color, int gap) {
		TextView label = new TextView(activity);
		label.setText(value);
		label.setTextSize(size);
		label.setTextColor(color);
		LinearLayout.LayoutParams params = new LinearLayout.LayoutParams(-1, -2);
		params.topMargin = dp(gap);
		column.addView(label, params);
		return label;
	}

	@JavascriptInterface
	public void openGroqSettings() {
		activity.runOnUiThread(() -> {
			boolean dark = (activity.getResources().getConfiguration().uiMode & Configuration.UI_MODE_NIGHT_MASK)
					== Configuration.UI_MODE_NIGHT_YES;
			int surface = dark ? 0xff192322 : 0xfff8fcfb;
			int field = dark ? 0xff293734 : 0xffe7f0ed;
			int primary = dark ? 0xffedf6f3 : 0xff132923;
			int secondary = dark ? 0xffafc5bd : 0xff416158;
			int accent = dark ? 0xff89e3c9 : 0xff00684f;
			int onAccent = dark ? 0xff10372d : 0xffffffff;
			int errorColor = dark ? 0xffffb4ab : 0xffac281f;

			ScrollView scroll = new ScrollView(activity);
			scroll.setBackground(groqSurface(surface, 24));
			LinearLayout column = new LinearLayout(activity);
			column.setOrientation(LinearLayout.VERTICAL);
			column.setPadding(dp(22), dp(20), dp(22), dp(16));
			scroll.addView(column);

			groqLabel(column, "Groq · GPT OSS 20B", 13, accent, 0);
			TextView title = groqLabel(column, "Ключ ИИ-помощника", 23, primary, 6);
			title.setTypeface(null, Typeface.BOLD);
			groqLabel(column, "Ключ хранится в приложении и передаётся через relay проекта LINK при запросах к Groq.", 14, secondary, 8);

			EditText input = new EditText(activity);
			input.setSingleLine(true);
			input.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_VARIATION_PASSWORD);
			input.setTextColor(primary);
			input.setHintTextColor(secondary);
			input.setHint(hasGroqKey() ? "Новый API-ключ" : "API-ключ Groq");
			input.setContentDescription("API-ключ Groq");
			input.setPadding(dp(14), 0, dp(12), 0);
			input.setBackground(groqSurface(field, 12));
			LinearLayout.LayoutParams inputParams = new LinearLayout.LayoutParams(-1, dp(52));
			inputParams.topMargin = dp(16);
			column.addView(input, inputParams);

			Button visibility = new Button(activity, null, android.R.attr.borderlessButtonStyle);
			visibility.setTextColor(accent);
			visibility.setAllCaps(false);
			visibility.setText("Показать ключ");
			column.addView(visibility, -2, dp(48));
			visibility.setOnClickListener(button -> {
				boolean masked = input.getTransformationMethod() instanceof android.text.method.PasswordTransformationMethod;
				input.setTransformationMethod(masked ? null : android.text.method.PasswordTransformationMethod.getInstance());
				input.setSelection(input.length());
				visibility.setText(masked ? "Скрыть ключ" : "Показать ключ");
			});

			TextView state = groqLabel(column, hasGroqKey() ? "Ключ сохранён. Оставьте поле пустым, чтобы проверить его снова."
					: "Введите ключ Groq, начинающийся с gsk_.", 14, secondary, 0);
			state.setAccessibilityLiveRegion(View.ACCESSIBILITY_LIVE_REGION_POLITE);

			Button verify = new Button(activity);
			verify.setTextColor(onAccent);
			verify.setAllCaps(false);
			verify.setText("Проверить и сохранить");
			verify.setBackground(groqSurface(accent, 14));
			LinearLayout.LayoutParams verifyParams = new LinearLayout.LayoutParams(-1, dp(52));
			verifyParams.topMargin = dp(14);
			column.addView(verify, verifyParams);

			LinearLayout footer = new LinearLayout(activity);
			column.addView(footer);
			Button remove = new Button(activity, null, android.R.attr.borderlessButtonStyle);
			remove.setTextColor(errorColor);
			remove.setAllCaps(false);
			remove.setText("Удалить");
			remove.setVisibility(hasGroqKey() ? View.VISIBLE : View.GONE);
			footer.addView(remove, new LinearLayout.LayoutParams(0, dp(48), 1));
			Button close = new Button(activity, null, android.R.attr.borderlessButtonStyle);
			close.setTextColor(primary);
			close.setAllCaps(false);
			close.setText("Закрыть");
			footer.addView(close, new LinearLayout.LayoutParams(0, dp(48), 1));

			AlertDialog dialog = new AlertDialog.Builder(activity).setView(scroll).create();
			close.setOnClickListener(button -> dialog.dismiss());
			remove.setOnClickListener(button -> {
				groqPreferences().edit().remove("apiKey").apply();
				remove.setVisibility(View.GONE);
				input.setHint("API-ключ Groq");
				state.setTextColor(secondary);
				state.setText("Сохранённый ключ удалён");
				verify.setText("Проверить и сохранить");
			});
			column.setFocusableInTouchMode(true);
			column.requestFocus();
			dialog.show();
			if (dialog.getWindow() != null) {
				dialog.getWindow().setBackgroundDrawable(new ColorDrawable(android.graphics.Color.TRANSPARENT));
			}
			verify.setOnClickListener(button -> {
				String entered = input.getText().toString().trim();
				String key = entered.isEmpty() ? groqPreferences().getString("apiKey", "") : entered;
				if (!key.startsWith("gsk_")) {
					state.setTextColor(errorColor);
					state.setText("Введите API-ключ Groq, начинающийся с gsk_.");
					return;
				}
				verify.setEnabled(false);
				input.setEnabled(false);
				visibility.setEnabled(false);
				remove.setEnabled(false);
				verify.setText("Проверяем ключ…");
				state.setTextColor(secondary);
				state.setText("Ожидаем ответ Groq");
				new Thread(() -> {
					try {
						JSONArray messages = new JSONArray().put(new JSONObject()
								.put("role", "user").put("content", "Reply with OK."));
						GroqRelay.chat(key, messages, 256);
						activity.runOnUiThread(() -> {
							if (!dialog.isShowing()) return;
							groqPreferences().edit().putString("apiKey", key).apply();
							input.setText("");
							input.setHint("Новый API-ключ");
							input.setEnabled(true);
							visibility.setEnabled(true);
							verify.setEnabled(true);
							remove.setEnabled(true);
							remove.setVisibility(View.VISIBLE);
							state.setTextColor(accent);
							state.setText("Ключ проверен и сохранён");
							verify.setText("Проверить ключ");
						});
					} catch (Exception error) {
						activity.runOnUiThread(() -> {
							if (!dialog.isShowing()) return;
							verify.setEnabled(true);
							visibility.setEnabled(true);
							input.setEnabled(true);
							state.setTextColor(errorColor);
							state.setText(groqError(error));
							verify.setText("Повторить проверку");
							remove.setEnabled(hasGroqKey());
						});
					}
				}).start();
			});
		});
	}

	private String groqError(Exception error) {
		if (error instanceof java.net.SocketTimeoutException) return "Relay долго не отвечает. Попробуйте ещё раз.";
		return error.getMessage() == null ? "Не удалось выполнить запрос Groq." : error.getMessage();
	}

	@JavascriptInterface
	public void requestGroq(int requestId, String messages, int maxTokens) {
		new Thread(() -> {
			String content = "";
			String error = "";
			try {
				String key = groqPreferences().getString("apiKey", "");
				if (key.isEmpty()) throw new IllegalStateException("Добавьте API-ключ Groq в настройках YTPro.");
				content = GroqRelay.chat(key, new JSONArray(messages), Math.min(4096, Math.max(256, maxTokens)));
			} catch (Exception failure) {
				error = groqError(failure);
			}
			String callback = "window.ytproGroqResult?.(" + requestId + ","
					+ JSONObject.quote(content) + "," + JSONObject.quote(error) + ")";
			activity.runOnUiThread(() -> web.evaluateJavascript(callback, null));
		}).start();
	}

	@JavascriptInterface
	public String getAllCookies(String url) {
		return CookieManager.getInstance().getCookie(url);
	}
	
	@JavascriptInterface
	public float getVolume() {
		int currentVolume = audioManager.getStreamVolume(AudioManager.STREAM_MUSIC);
		int maxVolume = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
		return (float) currentVolume / maxVolume;
	}
	
	@JavascriptInterface
	public void setVolume(float volume) {
		int max = audioManager.getStreamMaxVolume(AudioManager.STREAM_MUSIC);
		audioManager.setStreamVolume(AudioManager.STREAM_MUSIC, (int) (max * volume), 0);
	}
	
	@JavascriptInterface
	public float getBrightness() {
		try {
			return (Settings.System.getInt(activity.getContentResolver(), Settings.System.SCREEN_BRIGHTNESS) / 255f) * 100f;
		} catch (Settings.SettingNotFoundException e) {
			return 50f;
		}
	}
	
	@JavascriptInterface
	public void setBrightness(final float brightnessValue) {
		activity.runOnUiThread(() -> {
			float brightness = Math.max(0f, Math.min(brightnessValue, 1f));
			WindowManager.LayoutParams layout = activity.getWindow().getAttributes();
			layout.screenBrightness = brightness;
			activity.getWindow().setAttributes(layout);
		});
	}
	
	@JavascriptInterface
	public void resetBrightness() {
		activity.runOnUiThread(() -> {
			WindowManager.LayoutParams layout = activity.getWindow().getAttributes();
			layout.screenBrightness = WindowManager.LayoutParams.BRIGHTNESS_OVERRIDE_NONE;
			activity.getWindow().setAttributes(layout);
		});
	}

	@JavascriptInterface
	public void pipvid(String mode) {
		if (android.os.Build.VERSION.SDK_INT >= 26) {
			try {
				PictureInPictureParams params = new PictureInPictureParams.Builder()
				.setAspectRatio(new Rational(mode.equals("portrait") ? 9 : 16, mode.equals("portrait") ? 16 : 9))
				.build();
				activity.enterPictureInPictureMode(params);
			} catch (Exception e) { e.printStackTrace(); }
		} else {
			Toast.makeText(activity, activity.getString(R.string.no_pip), Toast.LENGTH_SHORT).show();
		}
	}
}
