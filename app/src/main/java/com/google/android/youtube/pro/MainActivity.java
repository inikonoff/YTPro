package com.google.android.youtube.pro;

import android.app.Activity;
import android.app.PendingIntent;
import android.app.PictureInPictureParams;
import android.app.RemoteAction;
import android.content.Context;
import android.content.Intent;
import android.content.IntentFilter;
import android.content.SharedPreferences;
import android.content.pm.PackageManager;
import android.content.res.Configuration;
import android.graphics.drawable.Icon;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.util.Rational;
import android.view.View;
import android.view.WindowManager;
import android.webkit.CookieManager;
import android.widget.Toast;
import android.window.OnBackInvokedCallback;
import android.window.OnBackInvokedDispatcher;
import android.widget.Button;

import java.util.ArrayList;
import java.util.List;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

// Import the separated components
import com.google.android.youtube.pro.webview.YTProWebView;
import com.google.android.youtube.pro.webview.YTProWebViewClient;
import com.google.android.youtube.pro.webview.YTProWebChromeClient;
import com.google.android.youtube.pro.webview.WebAppInterface;
import com.google.android.youtube.pro.webview.BinaryStreamManager;

import com.google.android.youtube.pro.receivers.MediaCommandReceiver;
import com.google.android.youtube.pro.receivers.NotificationActionReceiver;

public class MainActivity extends Activity {

    // PiP button that hides the video and keeps the sound playing in the background.
    public static final String ACTION_AUDIO_ONLY = "AUDIO_ONLY_ACTION";
    private static final Pattern SHORTS_URL = Pattern.compile("youtube\\.com/shorts/([\\w-]+)");

    public boolean portrait = false;
    public boolean isPlaying = false;
    public boolean mediaSession = false;
    public boolean isPip = false;
    public boolean dL = false;

    private YTProWebView web;
    private MediaCommandReceiver broadcastReceiver;
    private OnBackInvokedCallback backCallback;
    private boolean pipPortrait = false;
    public BinaryStreamManager streamManager;
    
    

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.main);
        
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
        
        // Shorts are disabled in this fork: open shorts links as regular videos.
        Matcher shorts = SHORTS_URL.matcher(url);
        if (shorts.find()) url = "https://m.youtube.com/watch?v=" + shorts.group(1);

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
        broadcastReceiver = new MediaCommandReceiver(this, web);
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

    private void handleBackPress() {
        // The gestures module consumes Back while the in-app mini player is open.
        web.evaluateJavascript("(function(){try{return !!(window.__ytproBack && window.__ytproBack());}catch(e){return false;}})()", value -> {
            if ("true".equals(value)) return;
            if (web.canGoBack()) {
                web.goBack();
            } else {
                finish();
            }
        });
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
        web.evaluateJavascript(isInPictureInPictureMode ? "PIPlayer();" : "removePIP();", null);
        isPip = isInPictureInPictureMode;
    }

    @Override
    protected void onUserLeaveHint() {
        super.onUserLeaveHint();
        if (Build.VERSION.SDK_INT >= 26 && web.getUrl() != null && web.getUrl().contains("watch")) {
            if (isPlaying) enterPip(portrait);
        }
    }

    public void enterPip(boolean portraitVideo) {
        if (Build.VERSION.SDK_INT < 26) return;
        pipPortrait = portraitVideo;
        try {
            isPip = true;
            enterPictureInPictureMode(buildPipParams());
        } catch (IllegalStateException e) {
            isPip = false;
            e.printStackTrace();
        }
    }

    /* PiP buttons: audio only (instead of "previous"), play/pause, next. */
    @android.annotation.TargetApi(26)
    private PictureInPictureParams buildPipParams() {
        List<RemoteAction> actions = new ArrayList<>();
        actions.add(pipAction(R.drawable.ic_headphones_white, R.string.pip_audio_only, ACTION_AUDIO_ONLY, 101));
        if (isPlaying) {
            actions.add(pipAction(R.drawable.ic_pause_white, R.string.pip_pause, "PAUSE_ACTION", 102));
        } else {
            actions.add(pipAction(R.drawable.ic_play_arrow_white, R.string.pip_play, "PLAY_ACTION", 103));
        }
        actions.add(pipAction(R.drawable.ic_skip_next_white, R.string.pip_next, "NEXT_ACTION", 104));
        return new PictureInPictureParams.Builder()
                .setAspectRatio(new Rational(pipPortrait ? 9 : 16, pipPortrait ? 16 : 9))
                .setActions(actions)
                .build();
    }

    @android.annotation.TargetApi(26)
    private RemoteAction pipAction(int icon, int title, String action, int requestCode) {
        Intent intent = new Intent(this, NotificationActionReceiver.class).setAction(action);
        PendingIntent pi = PendingIntent.getBroadcast(this, requestCode, intent,
                PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        String label = getString(title);
        return new RemoteAction(Icon.createWithResource(this, icon), label, label, pi);
    }

    /* Keeps the play/pause PiP button in sync with the player. */
    public void updatePipActions() {
        if (Build.VERSION.SDK_INT < 26 || !isInPictureInPictureMode()) return;
        try {
            setPictureInPictureParams(buildPipParams());
        } catch (IllegalStateException e) {
            e.printStackTrace();
        }
    }

    /* Headphones button: the PiP window goes away, playback continues in the background. */
    public void goAudioOnly() {
        if (Build.VERSION.SDK_INT >= 24 && isInPictureInPictureMode()) {
            moveTaskToBack(true);
        }
        // removePIP() pauses and resumes the video on the way out; make sure it keeps playing.
        web.postDelayed(() -> web.evaluateJavascript(
                "(function(){var v=document.querySelector('.video-stream');if(v&&v.paused)v.play();})()", null), 600);
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
