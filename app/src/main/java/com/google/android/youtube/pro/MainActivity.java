package com.google.android.youtube.pro;

import android.app.Activity;
import android.app.PictureInPictureParams;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.view.ViewTreeObserver;
import android.view.animation.DecelerateInterpolator;
import android.util.Rational;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.webkit.WebView;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.widget.Button;

// Import the separated components
import com.google.android.youtube.pro.webview.YTProWebView;
import com.google.android.youtube.pro.webview.YTProWebViewClient;
import com.google.android.youtube.pro.webview.YTProWebChromeClient;
import com.google.android.youtube.pro.webview.WebAppInterface;
import com.google.android.youtube.pro.webview.BinaryStreamManager;
import android.view.MotionEvent;
import android.os.SystemClock;
import android.view.OrientationEventListener;
import android.provider.Settings;
import android.content.pm.ActivityInfo;

import java.io.File;
import java.io.FileInputStream;
import java.io.IOException;
import java.io.OutputStream;

import com.google.android.youtube.pro.receivers.MediaCommandReceiver;

public class MainActivity extends Activity {

    private static final int CREATE_CAPTION_FILE = 3107;
    private File pendingCaptionFile;

    public void saveCaptionText(String filename, String text) {
        if (pendingCaptionFile != null) return;
        try {
            pendingCaptionFile = File.createTempFile("captions-", ".txt", getCacheDir());
            try (OutputStream output = new java.io.FileOutputStream(pendingCaptionFile)) {
                output.write(text.getBytes(java.nio.charset.StandardCharsets.UTF_8));
            }
            Intent picker = new Intent(Intent.ACTION_CREATE_DOCUMENT);
            picker.addCategory(Intent.CATEGORY_OPENABLE);
            picker.setType("text/plain");
            picker.putExtra(Intent.EXTRA_TITLE, filename.replace('/', '-').replace('\\', '-'));
            startActivityForResult(picker, CREATE_CAPTION_FILE);
        } catch (IOException | RuntimeException error) {
            if (pendingCaptionFile != null) pendingCaptionFile.delete();
            pendingCaptionFile = null;
            Toast.makeText(this, "Не удалось открыть сохранение файла.", Toast.LENGTH_SHORT).show();
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle state) {
        super.onSaveInstanceState(state);
        if (pendingCaptionFile != null) state.putString("pendingCaptionFile", pendingCaptionFile.getName());
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode != CREATE_CAPTION_FILE || pendingCaptionFile == null) return;
        File source = pendingCaptionFile;
        pendingCaptionFile = null;
        try {
            if (resultCode != RESULT_OK || data == null || data.getData() == null) return;
            try (FileInputStream input = new FileInputStream(source);
                 OutputStream output = getContentResolver().openOutputStream(data.getData())) {
                if (output == null) throw new IOException("Cannot open destination");
                byte[] buffer = new byte[8192];
                int count;
                while ((count = input.read(buffer)) != -1) output.write(buffer, 0, count);
            }
            Toast.makeText(this, "Файл сохранён.", Toast.LENGTH_SHORT).show();
        } catch (IOException | RuntimeException error) {
            Toast.makeText(this, "Не удалось сохранить файл.", Toast.LENGTH_SHORT).show();
        } finally {
            source.delete();
        }
    }

    public boolean portrait = false;
    public boolean isPlaying = false;
    // Android 12+: the system enters PiP by itself (with its own smooth animation) when the user
    // leaves the app while a video plays; kept in sync with playback and the current page.
    private boolean pipAutoEnter = false;

    // Rotate to fullscreen: turning the phone to landscape on a video opens fullscreen, turning it
    // back to portrait returns to the mode the video came from (page or miniplayer). Phones only.
    public boolean inFullscreen = false;
    private OrientationEventListener rotation;
    private int posture = 0;                 // 0 unknown, 1 portrait, 2 landscape (physical device)
    private boolean sawLandscapeInFs = false;
    private final Handler rotationHandler = new Handler(Looper.getMainLooper());
    private Runnable pendingPosture;
    private static final long POSTURE_MS = 350;   // the new posture must hold this long
    public boolean mediaSession = false;
    public boolean isPip = false;
    public boolean dL = false;

    private YTProWebView web;

    // Splash: kept on screen until the first YouTube page is painted (or 4 s), then dissolves.
    private boolean webReady = false;
    private static final long SPLASH_MAX_MS = 4000;
    private MediaCommandReceiver broadcastReceiver;
    private OnBackInvokedCallback backCallback;
    public BinaryStreamManager streamManager;
    
    

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        if (savedInstanceState != null) {
            String filename = savedInstanceState.getString("pendingCaptionFile");
            if (filename != null) pendingCaptionFile = new File(getCacheDir(), filename);
        }
        setContentView(R.layout.main);
        setupSplash();
        
        SharedPreferences prefs = getSharedPreferences("YTPRO", MODE_PRIVATE);
        if (!prefs.contains("bgplay")) {
            prefs.edit().putBoolean("bgplay", true).apply();
        }

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        load(false);
    }

    public void load(boolean dl) {
              
        
        this.dL = dl;
        web = findViewById(R.id.web);
        setupRotation();
        if (Build.VERSION.SDK_INT < 31 && !webReady) web.setAlpha(0f);   // revealed by onWebReady()
        // Keep the renderer process important while the screen is off, otherwise the system may
        // throttle or freeze it and background playback stops.
        if (Build.VERSION.SDK_INT >= 26) {
            web.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
        }
        
        web.getSettings().setJavaScriptEnabled(true);
        web.getSettings().setSupportZoom(true);
        web.getSettings().setBuiltInZoomControls(true);
        web.getSettings().setDisplayZoomControls(false);
        web.getSettings().setDomStorageEnabled(true);
        web.getSettings().setDatabaseEnabled(true);
        web.getSettings().setMediaPlaybackRequiresUserGesture(false); 
        // No LAYER_TYPE_HARDWARE: an offscreen layer around WebView re-renders the whole page into an
        // extra buffer every frame and makes animations stutter. WebView is GPU-accelerated without it.

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
            cookieManager.setAcceptThirdPartyCookies(web, true);
        }

        Intent intent = getIntent();
        String action = intent.getAction();
        Uri data = intent.getData();
        String url = "https://m.youtube.com/";
        if (Intent.ACTION_VIEW.equals(action) && data != null) {
            url = data.toString();
        } else if (Intent.ACTION_SEND.equals(action)) {
            String sharedText = intent.getStringExtra(Intent.EXTRA_TEXT);
            if (sharedText != null && (sharedText.contains("youtube.com") || sharedText.contains("youtu.be"))) {
                url = sharedText;
            }
        }
        
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) {
          web.getSettings().setMixedContentMode(android.webkit.WebSettings.MIXED_CONTENT_ALWAYS_ALLOW);
        }


        web.addJavascriptInterface(new WebAppInterface(this, web), "Android");
        web.setWebChromeClient(new YTProWebChromeClient(this, web));
        web.setWebViewClient(new YTProWebViewClient(this, web));
        
        web.loadUrl(url);

        setupReceiver();
        setupBackNavigation();
        streamManager = new BinaryStreamManager(web,this);
        
        
    }
         

   

    private void setupReceiver() {
        broadcastReceiver = new MediaCommandReceiver(web);
        if (Build.VERSION.SDK_INT >= 34 && getApplicationInfo().targetSdkVersion >= 34) {
            registerReceiver(broadcastReceiver, new IntentFilter("TRACKS_TRACKS"), RECEIVER_EXPORTED);
        } else {
            registerReceiver(broadcastReceiver, new IntentFilter("TRACKS_TRACKS"));
        }
    }

    private void setupBackNavigation() {
        if (Build.VERSION.SDK_INT >= 33) {
            OnBackInvokedDispatcher dispatcher = getOnBackInvokedDispatcher();
            backCallback = new OnBackInvokedCallback() {
                @Override
                public void onBackInvoked() {
                    handleBackPress();
                }
            };
            dispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT, backCallback);
        }
    }

    private void setupSplash() {
        if (Build.VERSION.SDK_INT >= 31) {
            // Hold the system splash until the page is ready, then fade it out with a gentle zoom.
            final View content = findViewById(android.R.id.content);
            content.getViewTreeObserver().addOnPreDrawListener(new ViewTreeObserver.OnPreDrawListener() {
                @Override
                public boolean onPreDraw() {
                    if (!webReady) return false;
                    content.getViewTreeObserver().removeOnPreDrawListener(this);
                    return true;
                }
            });
            getSplashScreen().setOnExitAnimationListener(splashView -> {
                View icon = splashView.getIconView();
                if (icon != null) {
                    icon.animate().scaleX(1.18f).scaleY(1.18f).alpha(0f)
                            .setDuration(380).setInterpolator(new DecelerateInterpolator(1.6f)).start();
                }
                splashView.animate().alpha(0f).setStartDelay(60).setDuration(420)
                        .setInterpolator(new DecelerateInterpolator(1.4f))
                        .withEndAction(splashView::remove).start();
            });
        }
        // Never wait forever (offline, slow network).
        new Handler(Looper.getMainLooper()).postDelayed(this::onWebReady, SPLASH_MAX_MS);
    }

    /** Called by YTProWebViewClient when the first page is visible. */
    public void onWebReady() {
        if (webReady) return;
        webReady = true;
        if (Build.VERSION.SDK_INT >= 31) return;   // system splash exit animation does the rest
        // Before Android 12 the "splash" is the window background behind the WebView: fade the page in over it.
        if (web == null) return;
        web.animate().alpha(1f).setDuration(420).setInterpolator(new DecelerateInterpolator(1.6f))
                .withEndAction(() -> getWindow().setBackgroundDrawableResource(R.color.splash)).start();
    }

    private void handleBackPress() {
        // The in-app miniplayer handles back itself (its video list lives in an iframe).
        web.evaluateJavascript("(window.ytproMini && ytproMini.back()) ? '1' : '0'", value -> {
            if ("\"1\"".equals(value)) return;
            if (web.canGoBack()) {
                web.goBack();
            } else {
                finish();
            }
        });
    }

    private boolean bgPlayOn() {
        return getSharedPreferences("YTPRO", MODE_PRIVATE).getBoolean("bgplay", false);
    }

    @Override
    protected void onStart() {
        super.onStart();
        if (web != null) web.evaluateJavascript("window.ytproBackground && ytproBackground(false);", null);
    }

    @Override
    protected void onStop() {
        super.onStop();
        // Screen locked or app minimised: stop YouTube from pausing the video by itself.
        if (web != null && bgPlayOn()) {
            web.evaluateJavascript("window.ytproBackground && ytproBackground(true);", null);
        }
    }

    @Override
    public void onBackPressed() {
        handleBackPress();
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == 101) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_GRANTED) {
                web.loadUrl("https://m.youtube.com");
            } else {
                Toast.makeText(getApplicationContext(), getString(R.string.grant_mic), Toast.LENGTH_SHORT).show();
            }
        } else if (requestCode == 1) {
            if (grantResults.length > 0 && grantResults[0] == PackageManager.PERMISSION_DENIED) {
                Toast.makeText(getApplicationContext(), getString(R.string.grant_storage), Toast.LENGTH_SHORT).show();
            }
        }
    }

    @Override
    public void onPictureInPictureModeChanged(boolean isInPictureInPictureMode, Configuration newConfig) {
        isPip = isInPictureInPictureMode;
        if (!isInPictureInPictureMode && Build.VERSION.SDK_INT >= 31) {
            updatePipParams(true);          // PiP ended: set the params again from the current state
        }
        web.evaluateJavascript(isInPictureInPictureMode ? "PIPlayer();" : "removePIP();", null);
    }

    /** Playback state from the page (bgStart/bgPlay/bgPause...). Updates the auto-PiP setting. */
    public void setPlaying(boolean playing) {
        isPlaying = playing;
        if (Build.VERSION.SDK_INT >= 31) runOnUiThread(() -> updatePipParams(false));
    }

    private boolean onVideoPage() {
        String u = web != null ? web.getUrl() : null;
        return u != null && (u.contains("watch") || u.contains("shorts"));
    }

    private void updatePipParams(boolean force) {
        if (Build.VERSION.SDK_INT < 31 || web == null || isPip) return;
        boolean auto = isPlaying && onVideoPage();
        if (auto == pipAutoEnter && !force) return;
        pipAutoEnter = auto;
        try {
            setPictureInPictureParams(new PictureInPictureParams.Builder()
                    .setAspectRatio(new Rational(portrait ? 9 : 16, portrait ? 16 : 9))
                    .setAutoEnterEnabled(auto)
                    .setSeamlessResizeEnabled(false)      // recommended for video content
                    .build());
        } catch (IllegalStateException | IllegalArgumentException e) {
            pipAutoEnter = false;
        }
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (Build.VERSION.SDK_INT >= 26 && web.getUrl() != null && (web.getUrl().contains("watch") || web.getUrl().contains("shorts"))) {
            if (isPlaying) {
                try {

         /**Webview requires gesture for FullScreenView which is used for PiP mode , this does that ig.*/
         web.loadUrl("javascript:showCurtain();");
         long downTime = SystemClock.uptimeMillis();
         long eventTime = downTime;

         float x = web.getWidth() / 2f;
         float y = 10f; 
         MotionEvent down = MotionEvent.obtain(downTime, eventTime, MotionEvent.ACTION_DOWN, x, y, 0);
         web.dispatchTouchEvent(down);

         eventTime += 15; 
         MotionEvent up = MotionEvent.obtain(downTime, eventTime, MotionEvent.ACTION_UP, x, y, 0);
         web.dispatchTouchEvent(up);
         down.recycle();
         up.recycle();
         web.loadUrl( "javascript:hideCurtain();");
                 
                    // Android 12+ with auto-enter: the system is already animating into PiP.
                    if (!(Build.VERSION.SDK_INT >= 31 && pipAutoEnter)) {
                        PictureInPictureParams params = new PictureInPictureParams.Builder()
                                .setAspectRatio(new Rational(portrait ? 9 : 16, portrait ? 16 : 9))
                                .build();
                        enterPictureInPictureMode(params);
                    }
                } catch (IllegalStateException e) {
                    e.printStackTrace();
                }
            }
        }
    }

    /** Orientation of the app outside fullscreen: portrait on phones (rotation is handled as a gesture). */
    public int normalOrientation() {
        return isPhone() ? ActivityInfo.SCREEN_ORIENTATION_PORTRAIT : ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED;
    }

    private boolean isPhone() {
        return getResources().getConfiguration().smallestScreenWidthDp < 600;
    }

    private boolean autoRotateOn() {
        try {
            return Settings.System.getInt(getContentResolver(), Settings.System.ACCELEROMETER_ROTATION, 0) == 1;
        } catch (Exception e) {
            return false;
        }
    }

    private void setupRotation() {
        if (!isPhone()) return;
        setRequestedOrientation(normalOrientation());
        rotation = new OrientationEventListener(this) {
            @Override
            public void onOrientationChanged(int angle) {
                if (angle == ORIENTATION_UNKNOWN) return;          // lying flat
                int p;
                if (angle >= 330 || angle <= 30) p = 1;
                else if ((angle >= 60 && angle <= 120) || (angle >= 240 && angle <= 300)) p = 2;
                else return;                                         // between the zones: keep the last one
                if (p == posture) { if (pendingPosture != null) { rotationHandler.removeCallbacks(pendingPosture); pendingPosture = null; } return; }
                if (pendingPosture != null) rotationHandler.removeCallbacks(pendingPosture);
                final int next = p;
                pendingPosture = () -> { pendingPosture = null; onPosture(next); };
                rotationHandler.postDelayed(pendingPosture, POSTURE_MS);
            }
        };
    }

    private void onPosture(int p) {
        int was = posture;
        posture = p;
        if (p == 2 && inFullscreen) sawLandscapeInFs = true;
        if (was == 0 || isPip || web == null || !autoRotateOn()) return;
        if (p == 2 && !inFullscreen && onVideoPage()) {
            // Fullscreen needs a user gesture: a synthetic tap on a transparent shield, then enter.
            web.evaluateJavascript("window.ytproAutoFs && ytproAutoFs.shield(true)", v -> {
                if (!"true".equals(v)) return;
                long t = SystemClock.uptimeMillis();
                float x = web.getWidth() / 2f, y = web.getHeight() / 2f;
                MotionEvent down = MotionEvent.obtain(t, t, MotionEvent.ACTION_DOWN, x, y, 0);
                MotionEvent up = MotionEvent.obtain(t, t + 15, MotionEvent.ACTION_UP, x, y, 0);
                web.dispatchTouchEvent(down);
                web.dispatchTouchEvent(up);
                down.recycle();
                up.recycle();
                rotationHandler.postDelayed(() ->
                        web.evaluateJavascript("window.ytproAutoFs && ytproAutoFs.enter()", null), 60);
            });
        } else if (p == 1 && inFullscreen && sawLandscapeInFs) {
            web.evaluateJavascript("window.ytproAutoFs && ytproAutoFs.exit()", null);
        }
    }

    /** Called by YTProWebChromeClient when fullscreen starts or ends. */
    public void onFullscreenChanged(boolean on) {
        inFullscreen = on;
        sawLandscapeInFs = on && posture == 2;
    }

    @Override
    protected void onResume() {
        super.onResume();
        if (rotation != null && rotation.canDetectOrientation()) rotation.enable();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (rotation != null) rotation.disable();
        if (pendingPosture != null) { rotationHandler.removeCallbacks(pendingPosture); pendingPosture = null; }
        CookieManager.getInstance().flush();
    }

    @Override
    public void onDestroy() {
        super.onDestroy();
        stopService(new Intent(getApplicationContext(), ForegroundService.class));
        if (broadcastReceiver != null) unregisterReceiver(broadcastReceiver);
        if (Build.VERSION.SDK_INT >= 33 && backCallback != null) {
            getOnBackInvokedDispatcher().unregisterOnBackInvokedCallback(backCallback);
        }
        if (streamManager != null) {
            streamManager.cleanup();
        }
    }
}
