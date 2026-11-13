import React, {useEffect, useState} from 'react';

import {checkDesktopLogin, hasPendingDesktopLogin, isDesktopApp, startDesktopLogin} from './desktop_login';

const PLUGIN_ID = 'mattermost-oidc';
const OAUTH2_BASE = `/plugins/${PLUGIN_ID}/oauth2`;
const DESKTOP_STATUS_TEXT = {
    starting: 'Redirecting to browser...',
    waiting: 'Authenticating in the browser, awaiting valid token.',
    error: 'Something went wrong. Click the button to try again.',
};

// OIDCLoginButton adds a custom SSO button to the Mattermost login page.
const OIDCLoginButton = () => {
    const [config, setConfig] = useState(null);
    const [loading, setLoading] = useState(true);
    const [desktopStatus, setDesktopStatus] = useState('');

    useEffect(() => {
        const controller = new AbortController();
        fetch(`/plugins/${PLUGIN_ID}/api/v1/config`, {signal: controller.signal})
            .then((res) => {
                if (!res.ok) {
                    throw new Error(`HTTP ${res.status}`);
                }
                return res.json();
            })
            .then((data) => {
                setConfig(data);
                setLoading(false);
            })
            .catch((err) => {
                if (err.name !== 'AbortError') {
                    console.error('Failed to load OIDC config:', err);
                    setLoading(false);
                }
            });
        return () => controller.abort();
    }, []);

    useEffect(() => {
        if (!isDesktopApp(window.navigator.userAgent)) {
            return undefined;
        }

        // The app delivers the deep link as a history push or as a full page load.
        const check = () => checkDesktopLogin({base: OAUTH2_BASE}).then((status) => status && setDesktopStatus(status));
        check();
        const timer = setInterval(() => hasPendingDesktopLogin() && check(), 500);
        return () => clearInterval(timer);
    }, []);

    if (loading || !config || !config.enable) {
        return null;
    }

    const handleClick = () => {
        const {pathname, search} = window.location;
        const invitePage = pathname.startsWith('/signup_') ? pathname + search : '/';
        const returnTo = new URLSearchParams(search).get('redirect_to') || invitePage;
        const base = `${OAUTH2_BASE}/connect?return_to=${encodeURIComponent(returnTo)}`;

        if (isDesktopApp(window.navigator.userAgent)) {
            setDesktopStatus('starting');
            startDesktopLogin({base: OAUTH2_BASE, returnTo})
                .then(() => setDesktopStatus('waiting'))
                .catch((err) => {
                    console.error('Failed to start desktop login:', err);
                    setDesktopStatus('error');
                });
            return;
        }
        window.location.href = base;
    };

    const buttonStyle = {
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: '100%',
        padding: '12px 16px',
        marginBottom: '8px',
        border: 'none',
        borderRadius: '4px',
        backgroundColor: config.button_color || '#0058CC',
        color: '#FFFFFF',
        fontSize: '14px',
        fontWeight: '600',
        cursor: 'pointer',
        transition: 'opacity 0.15s ease',
    };

    const iconStyle = {
        width: '20px',
        height: '20px',
        marginRight: '8px',
    };

    return (
        <>
        <button
            style={buttonStyle}
            onClick={handleClick}
            onMouseOver={(e) => e.currentTarget.style.opacity = '0.85'}
            onMouseOut={(e) => e.currentTarget.style.opacity = '1'}
            type='button'
        >
            <svg style={iconStyle} viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'>
                <path
                    d='M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm-1 17.93c-3.95-.49-7-3.85-7-7.93 0-.62.08-1.21.21-1.79L9 15v1c0 1.1.9 2 2 2v1.93zm6.9-2.54c-.26-.81-1-1.39-1.9-1.39h-1v-3c0-.55-.45-1-1-1H8v-2h2c.55 0 1-.45 1-1V7h2c1.1 0 2-.9 2-2v-.41c2.93 1.19 5 4.06 5 7.41 0 2.08-.8 3.97-2.1 5.39z'
                    fill='currentColor'
                />
            </svg>
            {config.button_text || 'Log in with OIDC'}
        </button>
        {desktopStatus && <p>{DESKTOP_STATUS_TEXT[desktopStatus]}</p>}
        </>
    );
};

// Fallback injection targets, for Mattermost < 7.8 (login) and pages without a plugin slot (signup).
const INJECTION_TARGETS = [
    {
        id: 'oidc-signup-button-container',
        paths: ['/signup_user_complete', '/signup_email'],
        selector: '.signup-body-card-content, .signup-body-content-button-container, .signup-body-card, .signup-team__container, .signup-body, .signup__content',
    },
    {
        id: 'oidc-login-button-container',
        paths: ['/login'],
        selector: '.signup-team__container, .login-body-card-content',
        legacyOnly: true,
    },
];

const insertContainer = (target, container) => {
    const anchor = target.querySelector('.signup-body-card-form-login-options');
    if (anchor) {
        anchor.appendChild(container);
        return;
    }
    const form = target.querySelector('form');
    if (form) {
        form.parentNode.insertBefore(container, form);
        return;
    }
    target.prepend(container);
};

class PluginClass {
    initialize(registry) {
        const hasLoginSlot = Boolean(registry.registerCustomLoginButtonComponent);
        if (hasLoginSlot) {
            registry.registerCustomLoginButtonComponent(OIDCLoginButton);
        }

        this.roots = new Map();
        this.targets = INJECTION_TARGETS.filter((t) => !(t.legacyOnly && hasLoginSlot));

        // Mattermost is a SPA: these pages can mount at any time after initialize.
        this.observer = new MutationObserver(() => this.injectButton());
        this.observer.observe(document.body, {childList: true, subtree: true});
        this.injectButton();
    }

    injectButton() {
        const {pathname} = window.location;
        const page = this.targets.find((t) => t.paths.some((p) => pathname.startsWith(p)));
        if (!page || document.getElementById(page.id)) {
            return;
        }
        const target = document.querySelector(page.selector);
        const {React: ReactLib, ReactDOM} = window;
        if (!target || !ReactLib || !ReactDOM) {
            return;
        }

        const container = document.createElement('div');
        container.id = page.id;
        container.style.width = '100%';
        insertContainer(target, container);

        const button = ReactLib.createElement(OIDCLoginButton);
        if (ReactDOM.createRoot) {
            const root = ReactDOM.createRoot(container);
            root.render(button);
            this.roots.set(page.id, root);
        } else {
            ReactDOM.render(button, container);
        }
    }

    uninitialize() {
        this.observer.disconnect();
        INJECTION_TARGETS.forEach(({id}) => {
            const container = document.getElementById(id);
            if (!container) {
                return;
            }
            if (this.roots.has(id)) {
                this.roots.get(id).unmount();
            } else {
                window.ReactDOM.unmountComponentAtNode(container);
            }
            container.remove();
        });
        this.roots.clear();
    }
}

window.registerPlugin(PLUGIN_ID, new PluginClass());
