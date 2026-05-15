const jwt = require('jsonwebtoken')
const supabase = require('../config/supabase')

// Verify JWT token
const authenticate = async (req, res, next) => {
  try {
    const authHeader = req.headers.authorization

    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ message: 'No token provided' })
    }

    const token = authHeader.split(' ')[1]

    const decoded = jwt.verify(token, process.env.JWT_SECRET)

    // Get fresh user from database
    const { data: user, error } = await supabase
      .from('users')
      .select('id, email, role, status')
      .eq('id', decoded.id)
      .single()

    if (error || !user) {
      return res.status(401).json({ message: 'Invalid token' })
    }

    if (user.status === 'inactive') {
      return res.status(403).json({ message: 'Account deactivated' })
    }

    req.user = user
    next()
  } catch (error) {
    return res.status(401).json({ message: 'Invalid or expired token' })
  }
}

// Check role
function authorizeRoles(...allowedRoles) {
  return function (req, res, next) {
    const role = req.user && req.user.role;
    if (!role || !allowedRoles.includes(role)) {
      return res.status(403).json({ message: 'Forbidden' });
    }
    next();
  };
}

function authorize(...roles) {
  return authorizeRoles(...roles);
}

// Aliases for both naming styles
const authenticateToken = authenticate;  // Alias for authenticateToken style
const authorizeRolesAlias = authorizeRoles; // Already exists
const authorizeAlias = authorize; // Already exists

// Export all variants for flexibility
module.exports = { 
  authenticate,      // Original name
  authenticateToken, // Alias for Bearer token style
  authorizeRoles,    // Original name
  authorizeRolesAlias, // Same as above
  authorize,         // Original name
  authorizeAlias     // Same as above
};