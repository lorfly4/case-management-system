// Middleware Cek Role
const isSPVOrAdmin = (req, res, next) => {
    if (req.session.role === 'admin' || req.session.role === 'spv') {
        return next();
    }
    res.status(403).send('Forbidden: Anda tidak punya akses distribusi.');
};

// Route Pilih PIC (Hanya Admin & SPV)
router.post('/assign-pic', isSPVOrAdmin, (req, res) => {
    const { case_id, pic_id } = req.body;
    const query = "UPDATE cases SET pic_id = ?, status = 'In Progress' WHERE id = ?";
    
    db.query(query, [pic_id, case_id], (err, result) => {
        if (err) throw err;
        res.redirect('/all-cases');
    });
});

// Route Tampilan Case (Filter Otomatis Jika Role = User)
router.get('/my-cases', (req, res) => {
    let query = "SELECT * FROM cases";
    let params = [];

    if (req.session.role === 'user') {
        query += " WHERE pic_id = ?";
        params.push(req.session.user_id);
    }

    db.query(query, params, (err, results) => {
        res.render('pages/all_cases', { cases: results });
    });
});