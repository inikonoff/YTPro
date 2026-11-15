package com.google.android.youtube.pro.webview;

import android.Manifest;
import android.content.pm.PackageManager;
import android.graphics.Bitmap;
import android.graphics.BitmapFactory;
import android.content.Context;
import android.content.SharedPreferences;
import android.os.Build;
import android.animation.ValueAnimator;
import android.view.ViewGroup;
import android.view.animation.AccelerateInterpolator;
import android.view.animation.DecelerateInterpolator;
import android.view.View;
import android.view.WindowManager;
import android.webkit.PermissionRequest;
import android.webkit.WebChromeClient;
import android.widget.FrameLayout;

// Import the main files from the parent package
import com.google.android.youtube.pro.MainActivity;
import com.google.android.youtube.pro.R;

public class YTProWebChromeClient extends WebChromeClient {
    private final MainActivity activity;
    private final YTProWebView web;
    
    private View mCustomView;
    private FrameLayout mCustomHolder;
    private WebChromeClient.CustomViewCallback mCustomViewCallback;
    private int mOriginalOrientation;
    private int mOriginalSystemUiVisibility;

    public YTProWebChromeClient(MainActivity activity, YTProWebView web) {
        this.activity = activity;
        this.web = web;
    }

    @Override
    public Bitmap getDefaultVideoPoster() {
        // Transparent poster: no grey "play" placeholder before the video starts.
        // (Upstream used a hardcoded resource id, which breaks whenever resources change.)
        return Bitmap.createBitmap(10, 10, Bitmap.Config.ARGB_8888);
    }

    @Override
    public void onShowCustomView(View paramView, WebChromeClient.CustomViewCallback viewCallback) {
        // 1. Determine orientation for FULL SCREEN
        mOriginalOrientation = activity.portrait ?
                android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT :
                android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;

        if (activity.isPip) mOriginalOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT;

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            activity.getWindow().setFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS, WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);
            WindowManager.LayoutParams params = activity.getWindow().getAttributes();
            params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_SHORT_EDGES;
            activity.getWindow().setAttributes(params);
        }

        if (mCustomView != null) {
            onHideCustomView();
            return;
        }

        mCustomView = paramView;
        mOriginalSystemUiVisibility = activity.getWindow().getDecorView().getSystemUiVisibility();
        
        // 2. Set the activity to full screen orientation (Landscape usually)
        activity.setRequestedOrientation(mOriginalOrientation);
        
        // Store portrait so onHideCustomView knows what to go back to
        mOriginalOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_PORTRAIT;

        mCustomViewCallback = viewCallback;
        // The fullscreen view gets its own window-visibility events. Without this wrapper a locked
        // screen tells WebView the page is hidden and playback stops, despite background play.
        mCustomHolder = new BgPlayFrame(activity);
        // The same view may still sit in a holder that is fading out from the previous exit.
        if (mCustomView.getParent() instanceof ViewGroup) ((ViewGroup) mCustomView.getParent()).removeView(mCustomView);
        mCustomHolder.addView(mCustomView, new FrameLayout.LayoutParams(-1, -1));
        ((FrameLayout) activity.getWindow().getDecorView()).addView(mCustomHolder, new FrameLayout.LayoutParams(-1, -1));
        if (animate()) {
            // Smooth entry: fade in from a slightly smaller video.
            mCustomHolder.setAlpha(0f);
            mCustomHolder.setScaleX(0.94f);
            mCustomHolder.setScaleY(0.94f);
            mCustomHolder.animate().alpha(1f).scaleX(1f).scaleY(1f).setDuration(300)
                    .setInterpolator(new DecelerateInterpolator(2.2f)).start();
        }
        activity.getWindow().getDecorView().setSystemUiVisibility(3846);
    }

    @Override
    public void onHideCustomView() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
            activity.getWindow().clearFlags(WindowManager.LayoutParams.FLAG_LAYOUT_NO_LIMITS);
            WindowManager.LayoutParams params = activity.getWindow().getAttributes();
            params.layoutInDisplayCutoutMode = WindowManager.LayoutParams.LAYOUT_IN_DISPLAY_CUTOUT_MODE_DEFAULT;
            activity.getWindow().setAttributes(params);
        }

        if (mCustomHolder != null) {
            final FrameLayout holder = mCustomHolder;
            final FrameLayout decor = (FrameLayout) activity.getWindow().getDecorView();
            mCustomHolder = null;
            Runnable drop = () -> {
                holder.removeAllViews();
                decor.removeView(holder);
            };
            if (animate()) {
                // Smooth exit: the fullscreen layer dissolves over the page.
                holder.animate().cancel();
                holder.animate().alpha(0f).scaleX(0.97f).scaleY(0.97f).setDuration(220)
                        .setInterpolator(new AccelerateInterpolator(1.4f)).withEndAction(drop).start();
            } else {
                drop.run();
            }
        }
        mCustomView = null;
        activity.getWindow().getDecorView().setSystemUiVisibility(mOriginalSystemUiVisibility);
        
        // 3. Set the activity BACK to the orientation saved right after going full screen (Portrait)
        activity.setRequestedOrientation(mOriginalOrientation);
        
        // Reset state for the next time we enter full screen
        mOriginalOrientation = activity.portrait ?
                android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_PORTRAIT :
                android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE;

        mCustomViewCallback = null;
        web.clearFocus();
    }

    /** No fade in PiP (tiny window) or when the user turned system animations off. */
    private boolean animate() {
        if (activity.isPip) return false;
        if (Build.VERSION.SDK_INT >= 24 && activity.isInPictureInPictureMode()) return false;
        return Build.VERSION.SDK_INT < 26 || ValueAnimator.areAnimatorsEnabled();
    }

    /** Hides "window is gone" from the fullscreen video when background play is on (same rule as YTProWebView). */
    private static class BgPlayFrame extends FrameLayout {
        BgPlayFrame(Context context) {
            super(context);
        }

        @Override
        public void dispatchWindowVisibilityChanged(int visibility) {
            SharedPreferences prefs = getContext().getSharedPreferences("YTPRO", Context.MODE_PRIVATE);
            boolean bgPlay = prefs.getBoolean("bgplay", false);
            if (visibility == View.VISIBLE || !bgPlay) {
                super.dispatchWindowVisibilityChanged(visibility);
            }
        }
    }

    @Override
    public void onPermissionRequest(final PermissionRequest request) {
        if (Build.VERSION.SDK_INT > 22 && request.getOrigin().toString().contains("youtube.com")) {
            if (activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_DENIED) {
                activity.requestPermissions(new String[]{Manifest.permission.RECORD_AUDIO}, 101);
            } else {
                request.grant(request.getResources());
            }
        }
    }
}