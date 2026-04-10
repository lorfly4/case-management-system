/**
 * Custom JavaScript for AdminLTE CMS Integration
 */

$(function () {
    'use strict'

    // Initialize AdminLTE Features
    initializeAdminLTE();
    setupEventListeners();
    setupNavigation();
});

/**
 * Initialize AdminLTE Components
 */
function initializeAdminLTE() {
    // Initialize tooltips if needed
    var tooltipTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="tooltip"]'))
    var tooltipList = tooltipTriggerList.map(function (tooltipTriggerEl) {
        return new bootstrap.Tooltip(tooltipTriggerEl)
    });

    // Initialize popovers if needed
    var popoverTriggerList = [].slice.call(document.querySelectorAll('[data-bs-toggle="popover"]'))
    var popoverList = popoverTriggerList.map(function (popoverTriggerEl) {
        return new bootstrap.Popover(popoverTriggerEl)
    });
}

/**
 * Setup Event Listeners
 */
function setupEventListeners() {
    // Close alert messages after 5 seconds
    $('.alert:not(.alert-permanent)').each(function() {
        setTimeout(() => {
            $(this).fadeOut('slow', function() {
                $(this).remove();
            });
        }, 5000);
    });

    // Confirm delete actions
    $(document).on('click', '[data-confirm]', function(e) {
        var message = $(this).data('confirm');
        if (!confirm(message)) {
            e.preventDefault();
            return false;
        }
    });
}

/**
 * Setup Navigation Active State
 */
function setupNavigation() {
    var currentPath = window.location.pathname;
    $('.nav-link').each(function() {
        var href = $(this).attr('href');
        if (href && currentPath.startsWith(href)) {
            $(this).addClass('active');
            $(this).closest('.nav-treeview').closest('.nav-item').find('.nav-link').first().addClass('active');
        }
    });
}

/**
 * Show Alert Message
 */
function showAlert(message, type = 'success') {
    var alertHtml = `
        <div class="alert alert-${type} alert-dismissible fade show" role="alert">
            ${message}
            <button type="button" class="btn-close" data-bs-dismiss="alert"></button>
        </div>
    `;
    var container = $('section.content');
    if (container.length) {
        container.prepend(alertHtml);
    }
}

/**
 * Format Date
 */
function formatDate(date, format = 'DD/MM/YYYY') {
    var d = new Date(date);
    var day = String(d.getDate()).padStart(2, '0');
    var month = String(d.getMonth() + 1).padStart(2, '0');
    var year = d.getFullYear();
    
    if (format === 'DD/MM/YYYY') {
        return `${day}/${month}/${year}`;
    }
    return d.toLocaleString();
}

/**
 * Handle Loading State
 */
function setLoading(element, isLoading = true) {
    if (isLoading) {
        $(element).prop('disabled', true).html('<span class="spinner-border spinner-border-sm me-2"></span>Loading...');
    } else {
        $(element).prop('disabled', false).html($(element).data('original-text') || 'Submit');
    }
}

/**
 * API Call Function
 */
async function apiCall(url, options = {}) {
    const defaultOptions = {
        headers: {
            'Content-Type': 'application/json',
        },
    };

    try {
        const response = await fetch(url, { ...defaultOptions, ...options });
        const data = await response.json();

        if (!response.ok) {
            throw new Error(data.error || 'An error occurred');
        }

        return data;
    } catch (error) {
        console.error('API Error:', error);
        showAlert(error.message, 'danger');
        throw error;
    }
}

/**
 * Validate Email
 */
function validateEmail(email) {
    var regex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    return regex.test(email);
}

/**
 * Validate Form
 */
function validateForm(formSelector) {
    var isValid = true;
    var $form = $(formSelector);

    $form.find('[required]').each(function() {
        var value = $(this).val().trim();
        if (value === '') {
            $(this).addClass('is-invalid');
            isValid = false;
        } else {
            $(this).removeClass('is-invalid');
        }
    });

    return isValid;
}

/**
 * Clear Form
 */
function clearForm(formSelector) {
    $(formSelector)[0].reset();
    $(formSelector).find('.form-control, .form-select').removeClass('is-invalid is-valid');
}
