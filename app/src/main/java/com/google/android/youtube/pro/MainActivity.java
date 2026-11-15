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

import com.google.android.youtube.pro.receivers.MediaCommandReceiver;

public class MainActivity extends Activity {

    public boolean portrait = false;
    public boolean isPlaying = false;
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
        web.setLayerType(View.LAYER_TYPE_HARDWARE, null);

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
        web.evaluateJavascript(isInPictureInPictureMode ? "PIPlayer();" : "removePIP();", null);
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
                 
                    PictureInPictureParams params = new PictureInPictureParams.Builder()
                            .setAspectRatio(new Rational(portrait ? 9 : 16, portrait ? 16 : 9))
                            .build();
                    enterPictureInPictureMode(params);
                } catch (IllegalStateException e) {
                    e.printStackTrace();
                }
            }
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
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
